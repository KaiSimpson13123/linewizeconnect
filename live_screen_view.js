/**
 * Linewize Connect - Live Screen View & P2P Stream Client
 *
 * This script:
 *  1. Listens for the Event Service URL (from chrome.storage.local or explicit config).
 *  2. Connects via Server-Sent Events (SSE) and waits for the INIT_P2P event.
 *  3. Connects to Ably Realtime signaling and establishes WebRTC P2P connection with the student peer.
 *  4. Manages the "control" DataChannel (receives tabs, switches active tab) and
 *     the "main" DataChannel (receives and reassembles screenshot frames delimited by \0\0).
 *  5. Sets up and renders the real-time live screen feed for the specified user.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LiveScreenViewer = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Utility: Reassembles chunks ending in double-null byte delimiter (\0\0) ---
  class ChunkBuffer {
    constructor(onMessage) {
      this.buffer = new Uint8Array(0);
      this.onMessage = onMessage;
    }

    append(data) {
      if (!data) return;
      const chunk = data instanceof Uint8Array ? data :
                    data instanceof ArrayBuffer ? new Uint8Array(data) :
                    new TextEncoder().encode(String(data));

      const newBuf = new Uint8Array(this.buffer.length + chunk.length);
      newBuf.set(this.buffer, 0);
      newBuf.set(chunk, this.buffer.length);
      this.buffer = newBuf;
      this.process();
    }

    process() {
      let delimIdx = -1;
      // Look for double-null byte terminator: \0\0 (0x00 0x00)
      for (let i = 0; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === 0 && this.buffer[i + 1] === 0) {
          delimIdx = i;
          break;
        }
      }

      if (delimIdx !== -1) {
        const msgBytes = this.buffer.slice(0, delimIdx);
        this.buffer = this.buffer.slice(delimIdx + 2);

        try {
          const str = new TextDecoder('utf-8').decode(msgBytes);
          if (str && str.trim()) {
            const json = JSON.parse(str);
            this.onMessage(json);
          }
        } catch (err) {
          console.error('[LiveScreenViewer] Chunk decode/parse error:', err);
        }

        if (this.buffer.length > 1) {
          this.process();
        }
      }
    }

    reset() {
      this.buffer = new Uint8Array(0);
    }
  }

  // --- Utility: Load Ably SDK dynamically if not already available ---
  async function ensureAbly() {
    if (typeof Ably !== 'undefined') return Ably;
    if (typeof window !== 'undefined' && window.Ably) return window.Ably;

    if (typeof document !== 'undefined') {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="ably"]');
        if (existing) {
          existing.addEventListener('load', () => resolve(window.Ably));
          existing.addEventListener('error', () => reject(new Error('Failed to load Ably from CDN')));
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdn.ably.com/lib/ably.min-1.js';
        script.async = true;
        script.onload = () => resolve(window.Ably);
        script.onerror = () => reject(new Error('Failed to load Ably Realtime library from CDN'));
        document.head.appendChild(script);
      });
    }

    if (typeof require === 'function') {
      try {
        return require('ably');
      } catch (e) {
        throw new Error('Ably Realtime is not installed. Run `npm install ably` to use in Node.js.');
      }
    }

    throw new Error('Ably Realtime library could not be loaded.');
  }

  // --- Main LiveScreenViewer Controller ---
  class LiveScreenViewer {
    /**
     * @param {Object} options
     * @param {string} options.targetUser - Target student email/username (e.g. "student@school.edu")
     * @param {string} [options.eventServiceUrl] - Event Service base URL (auto-detected if in extension)
     * @param {string} [options.deviceId] - Device / Appliance ID (auto-detected if in extension)
     * @param {string} [options.chromeId] - Chrome ID of the target (optional, extracted from INIT_P2P)
     * @param {string} [options.remotePeerId] - Viewer ID (default: "viewer_" + random ID)
     * @param {HTMLImageElement|HTMLCanvasElement} [options.renderTarget] - DOM element to render screenshots to
     * @param {Function} [options.onScreenshot] - Callback when a new screenshot frame is received ({ screenshot, tab_id, timestamp, fps, latency })
     * @param {Function} [options.onTabsUpdated] - Callback when student's open tabs are updated (tabsArray)
     * @param {Function} [options.onStatusChange] - Callback for status updates (statusString, detailsObj)
     * @param {Function} [options.onLog] - Callback for debug log messages
     * @param {Function} [options.onError] - Callback for errors
     */
    constructor(options = {}) {
      this.options = Object.assign({
        targetUser: '',
        eventServiceUrl: '',
        deviceId: '',
        chromeId: '',
        remotePeerId: 'viewer_' + Math.random().toString(36).substring(2, 9),
        renderTarget: null,
        useProxy: (typeof window !== 'undefined' && window.location.protocol.startsWith('http')),
        proxyUrl: '/api/proxy',
        sseProxyUrl: '/api/sse',
        onScreenshot: null,
        onTabsUpdated: null,
        onStatusChange: null,
        onLog: null,
        onError: null
      }, options);

      this.eventSource = null;
      this.ablyClient = null;
      this.ablyChannel = null;
      this.peerConnection = null;
      this.mainChannel = null;
      this.controlChannel = null;

      this.screenshotBuffer = new ChunkBuffer(this._handleScreenshotMessage.bind(this));
      this.controlBuffer = new ChunkBuffer(this._handleControlMessage.bind(this));

      this.tabs = [];
      this.currentStreamingTabId = null;
      this.currentStreamingWindowId = null;

      // Telemetry
      this.stats = {
        lastFrameTime: 0,
        fps: 0,
        frameCount: 0,
        latencyMs: 0,
        lastScreenshotSizeKB: 0,
        bytesReceived: 0,
        connectionState: 'idle'
      };

      this._fpsTimer = null;
      this._storageListener = null;
    }

    _log(msg, data) {
      const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
      const text = `[${timestamp}] ${msg}`;
      if (this.options.onLog) {
        this.options.onLog(text, data);
      } else {
        console.log(`[LiveScreenViewer] ${text}`, data !== undefined ? data : '');
      }
    }

    _setStatus(status, details = {}) {
      this.stats.connectionState = status;
      this._log(`Status -> ${status}`, details);
      if (this.options.onStatusChange) {
        this.options.onStatusChange(status, details);
      }
    }

    _emitError(err) {
      console.error('[LiveScreenViewer] Error:', err);
      if (this.options.onError) {
        this.options.onError(err);
      }
    }

    /**
     * Attempts to auto-detect eventServiceUrl, deviceId, and targetUser from extension storage.
     */
    async detectExtensionConfig() {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        this._log('Not running in extension environment; skipping storage auto-detect.');
        return null;
      }

      return new Promise((resolve) => {
        chrome.storage.local.get(null, (items) => {
          const config = {};
          for (const [key, rawVal] of Object.entries(items || {})) {
            const val = (rawVal && typeof rawVal === 'object' && 'value' in rawVal) ? rawVal.value : rawVal;
            if (key.includes('event_service_url') && !config.eventServiceUrl) config.eventServiceUrl = val;
            if (key.includes('device_id') && !key.includes('parent') && !config.deviceId) config.deviceId = val;
            if (key.includes('appliance_id') && !config.applianceId) config.applianceId = val;
            if (key.includes('chrome_id') && !config.chromeId) config.chromeId = val;
            if (key.includes('userInfo') && !config.userInfo) config.userInfo = val;
            if (key.includes('active_region') && !config.activeRegion) config.activeRegion = val;
          }

          if (config.eventServiceUrl) this.options.eventServiceUrl = config.eventServiceUrl;
          if (config.deviceId || config.applianceId) this.options.deviceId = config.deviceId || config.applianceId;
          if (!this.options.targetUser && config.userInfo) {
            this.options.targetUser = config.userInfo.user || config.userInfo.email || '';
          }
          if (config.chromeId) this.options.chromeId = config.chromeId;
          if (config.activeRegion) this.options.activeRegion = config.activeRegion;

          this._log('Auto-detected extension configuration:', {
            eventServiceUrl: this.options.eventServiceUrl,
            deviceId: this.options.deviceId,
            targetUser: this.options.targetUser,
            chromeId: this.options.chromeId,
            activeRegion: this.options.activeRegion
          });

          resolve(config);
        });
      });
    }

    /**
     * Method 4: Directly queries the Linewize Configuration Gateway API (configuration-gw.{region}.linewize.net)
     * to discover device configuration and retrieve the dynamic event_url (Event Service URL).
     *
     * @param {Object} [overrideOptions]
     * @param {string} [overrideOptions.region] - Regional code: 'syd-1' (US), 'syd-2' (AU), 'uk-1' (UK), 'beta-1', 'sit'
     * @param {string} [overrideOptions.targetUser] - Student email or username
     * @param {string} [overrideOptions.deviceId] - Appliance or device ID
     * @param {string} [overrideOptions.version] - Agent version (default: '4.0.5')
     * @returns {Promise<Object>} Retrieved configuration object including event_url
     */
    async fetchConfigFromGateway(overrideOptions = {}) {
      const user = overrideOptions.targetUser || this.options.targetUser || '';
      const deviceId = overrideOptions.deviceId || this.options.deviceId || '';
      const version = overrideOptions.version || (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || '4.0.5';
      const requestedRegion = overrideOptions.region || this.options.activeRegion;

      const candidateRegions = requestedRegion ? [requestedRegion] : ['syd-1', 'syd-2', 'uk-1', 'beta-1', 'sit'];

      this._log(`[Method 4] Querying Configuration Gateway across candidate regions: [${candidateRegions.join(', ')}]`, {
        user,
        deviceId,
        version
      });

      let lastError = null;

      // 1. Direct gateway configuration retrieval
      for (const reg of candidateRegions) {
        const directGatewayUrl = `https://configuration-gw.${reg}.linewize.net/get/configuration/chrome-extension?user=${encodeURIComponent(user)}&deviceid=${encodeURIComponent(deviceId)}&agt=chrome&ver=${encodeURIComponent(version)}`;
        const gatewayUrl = this.options.useProxy
          ? `${this.options.proxyUrl}?url=${encodeURIComponent(directGatewayUrl)}`
          : directGatewayUrl;

        this._log(`[Method 4] Probing gateway: ${directGatewayUrl} ${this.options.useProxy ? '(via CORS proxy)' : ''}`);

        try {
          const headers = {
            'Accept': 'application/json',
            'X-Actor-Id': user
          };
          if (deviceId || user) {
            headers['baggage'] = `applianceId=${deviceId},studentUsername=${user},agentType=chrome,agentVersion=${version}`;
          if (typeof window !== 'undefined' && window.__authToken) {
            headers['Authorization'] = `Bearer ${window.__authToken}`;
          }

          const response = await fetch(gatewayUrl, {
            method: 'GET',
            headers: headers,
            credentials: 'include'
          });

          if (response.ok) {
            const configData = await response.json();
            this._log(`[Method 4] Gateway successfully returned configuration for region [${reg}]!`, configData);

            if (configData.event_url) {
              this.options.eventServiceUrl = configData.event_url;
              this._log(`[Method 4] Retrieved Event Service URL -> ${configData.event_url}`);
            }
            if (configData.device_id && !this.options.deviceId) {
              this.options.deviceId = configData.device_id;
            }
            this.options.activeRegion = reg;
            this.gatewayConfig = configData;

            this._setStatus('gateway_config_retrieved', {
              region: reg,
              event_url: configData.event_url,
              device_id: configData.device_id
            });
            return configData;
          } else {
            this._log(`[Method 4] Gateway [${reg}] responded with HTTP ${response.status}`);
          }
        } catch (err) {
          lastError = err;
          this._log(`[Method 4] Gateway [${reg}] network error: ${err.message}`);
        }
      }

      // 2. User/Device Discovery fallback endpoint (if deviceId and user are available)
      if (deviceId && user) {
        for (const reg of candidateRegions) {
          const directUserIdUrl = `https://configuration-gw.${reg}.linewize.net/get/configuration/userid?deviceid=${encodeURIComponent(deviceId)}&identity=${encodeURIComponent(user)}`;
          const userIdUrl = this.options.useProxy
            ? `${this.options.proxyUrl}?url=${encodeURIComponent(directUserIdUrl)}`
            : directUserIdUrl;

          const reqHeaders = { 'Accept': 'application/json' };
          if (typeof window !== 'undefined' && window.__authToken) {
            reqHeaders['Authorization'] = `Bearer ${window.__authToken}`;
          }
          try {
            const res = await fetch(userIdUrl, { headers: reqHeaders, credentials: 'include' });
            if (res.ok) {
              const uData = await res.json();
              this._log(`[Method 4] User Discovery succeeded on [${reg}]:`, uData);
              if (uData.deviceid) this.options.deviceId = uData.deviceid;
              // Retry configuration retrieval with discovered device ID
              return this.fetchConfigFromGateway({ region: reg, targetUser: user, deviceId: uData.deviceid, version });
            }
          } catch(e) {}
        }
      }

      const msg = `Method 4: Failed to retrieve configuration from Gateway. (${lastError?.message || 'HTTP 404 / User or device not found'})`;
      this._log(msg);
      throw new Error(msg);
    }

    /**
     * Starts listening for the Event Service URL and dynamically updates if changed.
     */
    listenForEventServiceUrl() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        if (this._storageListener) {
          chrome.storage.onChanged.removeListener(this._storageListener);
        }
        this._storageListener = (changes, areaName) => {
          if (areaName === 'local') {
            for (const [key, change] of Object.entries(changes)) {
              if (key.includes('event_service_url')) {
                const newVal = (change.newValue && typeof change.newValue === 'object' && 'value' in change.newValue)
                  ? change.newValue.value
                  : change.newValue;
                if (newVal && newVal !== this.options.eventServiceUrl) {
                  this._log(`Event Service URL updated in storage: ${newVal}`);
                  this.options.eventServiceUrl = newVal;
                  // Reconnect if currently active
                  if (this.eventSource) {
                    this.connectEventService();
                  }
                }
              }
            }
          }
        };
        chrome.storage.onChanged.addListener(this._storageListener);
      }
    }

    /**
     * Step 1: Connect to Event Service SSE stream and wait for INIT_P2P.
     */
    async connectEventService() {
      if (!this.options.eventServiceUrl) {
        await this.detectExtensionConfig();
      }

      // Method 4 Fallback: If Event Service URL is still missing, query the Configuration Gateway!
      if (!this.options.eventServiceUrl && this.options.targetUser) {
        this._log('Event Service URL not cached; attempting Method 4 (Configuration Gateway)...');
        try {
          await this.fetchConfigFromGateway();
        } catch (gwErr) {
          this._log('Method 4 Gateway query: ' + gwErr.message);
        }
      }

      const { eventServiceUrl, deviceId, targetUser } = this.options;
      if (!eventServiceUrl) {
        throw new Error('Missing eventServiceUrl. Please provide one, use Auto-Detect, or click Query Gateway.');
      }
      if (!deviceId) {
        throw new Error('Missing deviceId (appliance ID).');
      }
      if (!targetUser) {
        throw new Error('Missing targetUser. Please specify the target user email or username.');
      }

      this._setStatus('connecting_event_service', { eventServiceUrl, deviceId, targetUser });

      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }

      // Event list matching the Linewize student extension subscription
      const events = 'CONFIG_UPDATE,OPEN_TAB,CLOSE_TAB,MESSAGE,CLASS_STARTED,POLICY_UPDATE,INIT_P2P,HEARTBEAT';
      const cleanUrl = eventServiceUrl.replace(/\/+$/, '');
      const sseUrl = `${cleanUrl}/events/v2/appliance/${deviceId}/recipient/${encodeURIComponent(targetUser)}?events=${events}`;
      const authTokenParam = (typeof window !== 'undefined' && window.__authToken) ? `&token=${window.__authToken}` : '';
      const finalSseUrl = this.options.useProxy
        ? `${this.options.sseProxyUrl}?url=${encodeURIComponent(sseUrl)}${authTokenParam}`
        : sseUrl;

      this._log(`Connecting EventSource to: ${finalSseUrl} ${this.options.useProxy ? '(via SSE CORS proxy)' : ''}`);

      try {
        this.eventSource = new EventSource(finalSseUrl, { withCredentials: true });

        this.eventSource.onopen = () => {
          this._setStatus('event_service_connected', { sseUrl });
          this._log('SSE Event Service connected successfully. Waiting for INIT_P2P event...');
        };

        this.eventSource.onerror = (err) => {
          this._log('SSE EventSource error/state change. ReadyState:', this.eventSource.readyState);
          if (this.eventSource.readyState === EventSource.CLOSED) {
            this._setStatus('event_service_disconnected');
          }
        };

        // Listen for Heartbeat
        this.eventSource.addEventListener('HEARTBEAT', (e) => {
          this._log('Received HEARTBEAT from Event Service');
        });

        // Listen for Policy/Config Updates
        this.eventSource.addEventListener('CONFIG_UPDATE', (e) => {
          this._log('Received CONFIG_UPDATE', e.data);
        });

        // Step 2: Listen for INIT_P2P
        this.eventSource.addEventListener('INIT_P2P', async (e) => {
          this._log('>>> Received INIT_P2P Event! <<<', e.data);
          try {
            const p2pPayload = JSON.parse(e.data);
            await this.handleInitP2P(p2pPayload);
          } catch (err) {
            this._emitError(new Error('Failed to parse or initialize P2P from INIT_P2P event: ' + err.message));
          }
        });

      } catch (err) {
        this._setStatus('error', { message: err.message });
        this._emitError(err);
        throw err;
      }
    }

    /**
     * Step 2: Handle INIT_P2P event and initialize Ably + WebRTC handshake.
     * @param {Object} initP2PData
     */
    async handleInitP2P(initP2PData) {
      this._setStatus('p2p_initializing', initP2PData);

      const {
        channel: channelName,
        signalToken,
        remotePeerId,
        peerAgentId,
        ice
      } = initP2PData;

      if (!channelName || !signalToken) {
        throw new Error('INIT_P2P missing channel or signalToken');
      }

      // Determine Student Peer ID:
      // In the extension: peerId is `${userInfo.user}_peerAgentId_${chromeId}`
      const studentAgentId = peerAgentId || this.options.chromeId || '';
      const studentPeerId = initP2PData.peerId || `${this.options.targetUser}_peerAgentId_${studentAgentId}`;
      const viewerPeerId = remotePeerId || this.options.remotePeerId;

      this._log('P2P Setup Parameters:', {
        channelName,
        viewerPeerId,
        studentPeerId,
        studentAgentId,
        hasSignalToken: !!signalToken,
        iceServers: ice?.iceServers
      });

      // 1. Initialize Ably Signaling Client
      const AblyLib = await ensureAbly();
      if (this.ablyClient) {
        try { this.ablyClient.close(); } catch(e) {}
      }

      this._log('Connecting to Ably Realtime signaling...');
      this.ablyClient = new AblyLib.Realtime({
        token: signalToken,
        clientId: viewerPeerId,
        queueMessages: false,
        disconnectedRetryTimeout: 3000
      });

      await new Promise((resolve, reject) => {
        this.ablyClient.connection.once('connected', () => {
          this._log('Ably Realtime connected successfully.');
          resolve();
        });
        this.ablyClient.connection.once('failed', (err) => reject(new Error('Ably connection failed: ' + JSON.stringify(err))));
      });

      // 2. Attach to Channel & Enter Presence
      this.ablyChannel = this.ablyClient.channels.get(channelName);
      await this.ablyChannel.attach();
      this._log(`Attached to Ably channel: ${channelName}`);

      try {
        await this.ablyChannel.presence.enter();
        this._log('Entered channel presence.');
      } catch (err) {
        this._log('Presence enter notice:', err.message);
      }

      // 3. Prepare WebRTC Peer Connection
      const iceServers = (ice && ice.iceServers) ? ice.iceServers : [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ];

      if (this.peerConnection) {
        try { this.peerConnection.close(); } catch(e) {}
      }

      this._log('Creating RTCPeerConnection with ICE servers:', iceServers);
      this.peerConnection = new RTCPeerConnection({ iceServers });

      // Track ICE candidates
      this.peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          this._log('Sending local ICE candidate to student peer');
          this.ablyChannel.publish('candidate', {
            receiver: studentPeerId,
            stamp: Date.now(),
            timestamp: Date.now(),
            candidate: candidate
          });
        }
      };

      this.peerConnection.onconnectionstatechange = () => {
        const state = this.peerConnection.connectionState;
        this._log(`RTCPeerConnection state: ${state}`);
        if (state === 'connected') {
          this._setStatus('p2p_connected');
          this._startFpsMeter();
        } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          this._setStatus('p2p_disconnected', { state });
          this._stopFpsMeter();
        }
      };

      // 4. Create WebRTC DataChannels (Viewer is Initiator)
      // "main" for screenshots, "control" for tab listing/switching
      this._setupMainChannel(this.peerConnection.createDataChannel('main'));
      this._setupControlChannel(this.peerConnection.createDataChannel('control'));

      // Also listen to ondatachannel in case channels are created passively
      this.peerConnection.ondatachannel = (event) => {
        const ch = event.channel;
        this._log(`Incoming remote DataChannel: ${ch.label}`);
        if (ch.label === 'main') {
          this._setupMainChannel(ch);
        } else if (ch.label === 'control') {
          this._setupControlChannel(ch);
        }
      };

      // 5. Subscribe to Ably messages from Student Peer
      this.ablyChannel.subscribe('connect', async (msg) => {
        const data = msg.data || {};
        if (data.receiver && data.receiver !== viewerPeerId) {
          return; // Message is for another peer
        }

        const desc = data.description;
        if (!desc) return;

        this._log(`Received SDP [${desc.type}] from student peer`);
        try {
          if (desc.type === 'answer') {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(desc));
            this._log('Applied remote SDP answer successfully.');
          } else if (desc.type === 'offer') {
            // Polite fallback
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(desc));
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            this.ablyChannel.publish('connect', {
              receiver: studentPeerId,
              stamp: Date.now(),
              timestamp: Date.now(),
              description: this.peerConnection.localDescription
            });
            this._log('Sent SDP answer back to student peer.');
          }
        } catch (err) {
          this._emitError(new Error('SDP handling error: ' + err.message));
        }
      });

      this.ablyChannel.subscribe('candidate', async (msg) => {
        const data = msg.data || {};
        if (data.receiver && data.receiver !== viewerPeerId) return;

        if (data.candidate && this.peerConnection) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (err) {
            this._log('Could not add ICE candidate:', err.message);
          }
        }
      });

      // 6. Create SDP Offer & publish to student
      this._log('Creating WebRTC SDP Offer...');
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this._log(`Publishing SDP offer to receiver: ${studentPeerId}`);
      await this.ablyChannel.publish('connect', {
        receiver: studentPeerId,
        stamp: Date.now(),
        timestamp: Date.now(),
        description: this.peerConnection.localDescription
      });

      this._setStatus('waiting_for_webrtc_handshake');
    }

    /**
     * Sets up the "main" DataChannel (receives screenshots).
     * @param {RTCDataChannel} channel
     */
    _setupMainChannel(channel) {
      this.mainChannel = channel;
      this.mainChannel.binaryType = 'arraybuffer';

      this.mainChannel.onopen = () => {
        this._log('Main DataChannel (screenshots) is OPEN!');
        this._setStatus('live_screen_viewing');
      };

      this.mainChannel.onclose = () => {
        this._log('Main DataChannel (screenshots) closed.');
      };

      this.mainChannel.onerror = (err) => {
        this._emitError(new Error('Main DataChannel error: ' + (err.message || 'unknown')));
      };

      this.mainChannel.onmessage = (event) => {
        this.stats.bytesReceived += event.data.byteLength || event.data.length || 0;
        this.screenshotBuffer.append(event.data);
      };
    }

    /**
     * Sets up the "control" DataChannel (receives tabs, sends tab switch commands).
     * @param {RTCDataChannel} channel
     */
    _setupControlChannel(channel) {
      this.controlChannel = channel;
      this.controlChannel.binaryType = 'arraybuffer';

      this.controlChannel.onopen = () => {
        this._log('Control DataChannel is OPEN!');
      };

      this.controlChannel.onclose = () => {
        this._log('Control DataChannel closed.');
      };

      this.controlChannel.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
          this.controlBuffer.append(event.data);
        } else if (typeof event.data === 'string') {
          try {
            const parsed = JSON.parse(event.data);
            this._handleControlMessage(parsed);
          } catch(e) {
            this.controlBuffer.append(new TextEncoder().encode(event.data));
          }
        }
      };
    }

    /**
     * Processes parsed messages from the "control" DataChannel.
     * Student TabStreamer sends: { type: "tab_update", tabs: [...] }
     */
    _handleControlMessage(msg) {
      if (!msg) return;

      if (msg.type === 'tab_update' && Array.isArray(msg.tabs)) {
        this.tabs = msg.tabs;
        this._log(`Received tab update: ${this.tabs.length} tabs open.`);

        // Find currently active tab
        const activeTab = this.tabs.find(t => t.active) || this.tabs[0];
        if (activeTab && (!this.currentStreamingTabId || !this.currentStreamingWindowId)) {
          const parts = (activeTab.tab_id || '').split('_');
          const winId = parts[0] ? parseInt(parts[0], 10) : 0;
          const tabId = parts[1] ? parseInt(parts[1], 10) : (activeTab.id || 0);

          this._log(`Auto-selecting active tab for screen streaming: "${activeTab.title}" (Window: ${winId}, Tab: ${tabId})`);
          this.switchTab(winId, tabId);
        }

        if (this.options.onTabsUpdated) {
          this.options.onTabsUpdated(this.tabs);
        }
      }
    }

    /**
     * Sends a command over the "control" DataChannel to switch the streamed tab.
     * @param {number} windowId
     * @param {number} tabId
     */
    switchTab(windowId, tabId) {
      this.currentStreamingWindowId = windowId;
      this.currentStreamingTabId = tabId;

      if (!this.controlChannel || this.controlChannel.readyState !== 'open') {
        this._log(`Cannot switch tab: Control channel state is ${this.controlChannel?.readyState}`);
        return false;
      }

      const payload = JSON.stringify({
        windowId: Number(windowId),
        tabId: Number(tabId)
      });

      this._log(`Sending switchTab command on control channel -> Window: ${windowId}, Tab: ${tabId}`);
      this.controlChannel.send(payload);
      return true;
    }

    /**
     * Processes reassembled screenshot packets from the "main" DataChannel.
     * Student SnapshotStreamer sends:
     * {
     *   type: "screenshot",
     *   tab_id: "windowId_tabId",
     *   screenshot: "data:image/jpeg;base64,...",
     *   timestamp: 1727342930000
     * }
     */
    _handleScreenshotMessage(msg) {
      if (!msg) return;

      if (msg.type === 'screenshot' && msg.screenshot) {
        const now = Date.now();
        this.stats.frameCount++;
        if (msg.timestamp) {
          this.stats.latencyMs = Math.max(0, now - msg.timestamp);
        }
        this.stats.lastScreenshotSizeKB = Math.round((msg.screenshot.length * 0.75) / 1024);

        // Render to target element if provided
        if (this.options.renderTarget) {
          const el = this.options.renderTarget;
          if (el.tagName === 'IMG') {
            el.src = msg.screenshot;
          } else if (el.tagName === 'CANVAS') {
            const ctx = el.getContext('2d');
            const img = new Image();
            img.onload = () => {
              if (el.width !== img.width || el.height !== img.height) {
                el.width = img.width;
                el.height = img.height;
              }
              ctx.drawImage(img, 0, 0);
            };
            img.src = msg.screenshot;
          }
        }

        // Invoke custom callback
        if (this.options.onScreenshot) {
          this.options.onScreenshot({
            screenshot: msg.screenshot,
            tabId: msg.tab_id,
            timestamp: msg.timestamp || now,
            latencyMs: this.stats.latencyMs,
            fps: this.stats.fps,
            sizeKB: this.stats.lastScreenshotSizeKB
          });
        }
      } else if (msg.type === 'screenshot_unavailable') {
        this._log('Student reported: screenshot unavailable (tab may be inactive or minimized).');
      }
    }

    _startFpsMeter() {
      this._stopFpsMeter();
      let lastCount = 0;
      this._fpsTimer = setInterval(() => {
        const currentCount = this.stats.frameCount;
        this.stats.fps = currentCount - lastCount;
        lastCount = currentCount;
      }, 1000);
    }

    _stopFpsMeter() {
      if (this._fpsTimer) {
        clearInterval(this._fpsTimer);
        this._fpsTimer = null;
      }
      this.stats.fps = 0;
    }

    /**
     * Cleanly terminates all connections and intervals.
     */
    disconnect() {
      this._log('Disconnecting live screen viewer...');
      this._stopFpsMeter();

      if (this.mainChannel) {
        try { this.mainChannel.close(); } catch(e) {}
        this.mainChannel = null;
      }

      if (this.controlChannel) {
        try { this.controlChannel.close(); } catch(e) {}
        this.controlChannel = null;
      }

      if (this.peerConnection) {
        try { this.peerConnection.close(); } catch(e) {}
        this.peerConnection = null;
      }

      if (this.ablyClient) {
        try { this.ablyClient.close(); } catch(e) {}
        this.ablyClient = null;
      }

      if (this.eventSource) {
        try { this.eventSource.close(); } catch(e) {}
        this.eventSource = null;
      }

      if (this._storageListener && typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.onChanged.removeListener(this._storageListener);
        this._storageListener = null;
      }

      this.screenshotBuffer.reset();
      this.controlBuffer.reset();
      this._setStatus('disconnected');
    }
  }

  // --- Convenience Factory Method ---
  function startLiveScreenView(options = {}) {
    const viewer = new LiveScreenViewer(options);
    viewer.listenForEventServiceUrl();
    viewer.connectEventService().catch((err) => {
      console.error('[LiveScreenViewer] Initialization failed:', err);
    });
    return viewer;
  }

  return {
    LiveScreenViewer,
    startLiveScreenView,
    ChunkBuffer
  };
});
