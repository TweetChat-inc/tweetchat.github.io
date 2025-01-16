// WebRTC Configuration
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

// State Management
const state = {
    localStream: null,
    screenStream: null,
    peerConnections: new Map(),
    callType: null,
    isHost: false,
    participants: new Set(),
    isLive: false,
    viewerCount: 0,
    likeCount: 0,
    callStartTime: null,
    backgroundEffect: 'none',
    layout: 'grid',
    selectedDevices: {
        audio: null,
        video: null,
        audioOutput: null
    }
};

// UI Elements
const elements = {
    screens: {
        type: document.getElementById('type-screen'),
        setup: document.getElementById('setup-screen'),
        call: document.getElementById('call-screen'),
        end: document.getElementById('end-screen')
    },
    video: {
        localPreview: document.getElementById('localPreview'),
        grid: document.getElementById('videoGrid')
    },
    controls: {
        video: document.getElementById('toggleVideo'),
        audio: document.getElementById('toggleAudio'),
        screenShare: document.getElementById('toggleScreenShare'),
        background: document.getElementById('toggleBackground'),
        endCall: document.getElementById('endCall')
    },
    selects: {
        videoSource: document.getElementById('videoSource'),
        audioSource: document.getElementById('audioSource'),
        audioOutput: document.getElementById('audioOutput')
    },
    buttons: {
        startCall: document.getElementById('startCall'),
        newCall: document.getElementById('newCall')
    },
    stats: {
        duration: document.getElementById('callDuration'),
        quality: document.getElementById('callQuality'),
        network: document.getElementById('networkSpeed')
    }
};

// Initialize Application
async function initializeApp() {
    try {
        // Load available devices
        await loadDevices();
        
        // Set up event listeners
        setupEventListeners();
        
        // Initialize background effects
        if (hasGPU()) {
            await initializeBodyPix();
        }
        
        // Show type selection screen
        showScreen('type');
    } catch (error) {
        showError('Initialization Error', error.message);
    }
}

// Device Management
async function loadDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        const audioDevices = devices.filter(device => device.kind === 'audioinput');
        const audioOutputDevices = devices.filter(device => device.kind === 'audiooutput');
        
        populateDeviceSelect(elements.selects.videoSource, videoDevices);
        populateDeviceSelect(elements.selects.audioSource, audioDevices);
        populateDeviceSelect(elements.selects.audioOutput, audioOutputDevices);
    } catch (error) {
        showError('Device Error', 'Could not load media devices');
    }
}

function populateDeviceSelect(select, devices) {
    select.innerHTML = '';
    devices.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `${device.kind} ${select.children.length + 1}`;
        select.appendChild(option);
    });
}

// Media Stream Management
async function startLocalStream() {
    try {
        if (state.localStream) {
            state.localStream.getTracks().forEach(track => track.stop());
        }
        
        const constraints = {
            audio: {
                deviceId: state.selectedDevices.audio ? { exact: state.selectedDevices.audio } : undefined,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: state.callType !== 'audio' ? {
                deviceId: state.selectedDevices.video ? { exact: state.selectedDevices.video } : undefined,
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30 }
            } : false
        };
        
        state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        elements.video.localPreview.srcObject = state.localStream;
        
        if (state.backgroundEffect !== 'none' && hasGPU()) {
            applyBackgroundEffect();
        }
    } catch (error) {
        showError('Media Error', 'Could not access camera or microphone');
    }
}

// Screen Sharing
async function toggleScreenShare() {
    try {
        if (state.screenStream) {
            stopScreenShare();
        } else {
            state.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "always"
                },
                audio: false
            });
            
            // Replace video track in all peer connections
            const videoTrack = state.screenStream.getVideoTracks()[0];
            for (let [peerId, pc] of state.peerConnections) {
                const sender = pc.getSenders().find(s => s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            }
            
            // Update local preview
            elements.video.localPreview.srcObject = state.screenStream;
            
            // Listen for screen share end
            videoTrack.onended = stopScreenShare;
            elements.controls.screenShare.classList.add('active');
        }
    } catch (error) {
        showError('Screen Share Error', error.message);
    }
}

function stopScreenShare() {
    if (state.screenStream) {
        state.screenStream.getTracks().forEach(track => track.stop());
        state.screenStream = null;
        
        // Revert to camera
        const videoTrack = state.localStream.getVideoTracks()[0];
        for (let [peerId, pc] of state.peerConnections) {
            const sender = pc.getSenders().find(s => s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
        }
        
        elements.video.localPreview.srcObject = state.localStream;
        elements.controls.screenShare.classList.remove('active');
    }
}

// Background Effects
let bodyPixNet;

async function initializeBodyPix() {
    try {
        bodyPixNet = await bodyPix.load({
            architecture: 'MobileNetV1',
            outputStride: 16,
            multiplier: 0.75,
            quantBytes: 2
        });
    } catch (error) {
        console.warn('Background effects not available:', error);
    }
}

async function applyBackgroundEffect() {
    if (!bodyPixNet || !state.localStream) return;
    
    const videoTrack = state.localStream.getVideoTracks()[0];
    const { width, height } = videoTrack.getSettings();
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    async function processFrame() {
        if (state.backgroundEffect === 'none') return;
        
        ctx.drawImage(elements.video.localPreview, 0, 0, width, height);
        const segmentation = await bodyPixNet.segmentPerson(canvas);
        
        if (state.backgroundEffect === 'blur') {
            const blurredImage = await bodyPix.blurBackground(canvas, segmentation);
            ctx.drawImage(blurredImage, 0, 0);
        } else if (state.backgroundEffect === 'virtual') {
            // Add virtual background implementation
        }
        
        requestAnimationFrame(processFrame);
    }
    
    processFrame();
    
    const processedStream = canvas.captureStream(30);
    elements.video.localPreview.srcObject = processedStream;
    
    // Update stream in peer connections
    const processedTrack = processedStream.getVideoTracks()[0];
    for (let [peerId, pc] of state.peerConnections) {
        const sender = pc.getSenders().find(s => s.track.kind === 'video');
        if (sender) {
            sender.replaceTrack(processedTrack);
        }
    }
}

// WebRTC Connection Management
async function createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(configuration);
    
    // Add local tracks
    state.localStream.getTracks().forEach(track => {
        pc.addTrack(track, state.localStream);
    });
    
    // Handle ICE candidates
    pc.onicecandidate = event => {
        if (event.candidate) {
            sendToPeer(peerId, {
                type: 'candidate',
                candidate: event.candidate
            });
        }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
        switch(pc.connectionState) {
            case 'connected':
                updateCallStatus('Connected');
                break;
            case 'disconnected':
                updateCallStatus('Reconnecting...');
                break;
            case 'failed':
                handlePeerDisconnect(peerId);
                break;
        }
    };
    
    // Handle remote tracks
    pc.ontrack = event => {
        const stream = event.streams[0];
        addRemoteStream(peerId, stream);
    };
    
    state.peerConnections.set(peerId, pc);
    return pc;
}

async function handleOffer(peerId, offer) {
    try {
        const pc = await createPeerConnection(peerId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        sendToPeer(peerId, {
            type: 'answer',
            answer: answer
        });
    } catch (error) {
        showError('Connection Error', error.message);
    }
}

async function handleAnswer(peerId, answer) {
    try {
        const pc = state.peerConnections.get(peerId);
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    } catch (error) {
        showError('Connection Error', error.message);
    }
}

async function handleCandidate(peerId, candidate) {
    try {
        const pc = state.peerConnections.get(peerId);
        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    } catch (error) {
        showError('Connection Error', error.message);
    }
}

// UI Management
function showScreen(screenName) {
    Object.keys(elements.screens).forEach(key => {
        elements.screens[key].classList.toggle('active', key === screenName);
    });
}

function updateCallStatus(status) {
    const statusElement = document.getElementById('callStatus');
    if (statusElement) {
        statusElement.textContent = status;
    }
}

function updateCallDuration() {
    if (!state.callStartTime) return;
    
    const duration = Math.floor((Date.now() - state.callStartTime) / 1000);
    const hours = Math.floor(duration / 3600);
    const minutes = Math.floor((duration % 3600) / 60);
    const seconds = duration % 60;
    
    const formatted = [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].join(':');
    
    elements.stats.duration.textContent = formatted;
}

function showError(title, message) {
    const dialog = document.getElementById('error-dialog');
    const titleElement = document.getElementById('error-title');
    const messageElement = document.getElementById('error-message');
    
    titleElement.textContent = title;
    messageElement.textContent = message;
    dialog.classList.add('active');
}

// Event Listeners
function setupEventListeners() {
    // Call type selection
    document.querySelectorAll('.type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.callType = btn.dataset.type;
            showScreen('setup');
        });
    });
    
    // Device selection
    elements.selects.videoSource.addEventListener('change', e => {
        state.selectedDevices.video = e.target.value;
        startLocalStream();
    });
    
    elements.selects.audioSource.addEventListener('change', e => {
        state.selectedDevices.audio = e.target.value;
        startLocalStream();
    });
    
    elements.selects.audioOutput.addEventListener('change', e => {
        state.selectedDevices.audioOutput = e.target.value;
        if (typeof elements.video.localPreview.sinkId !== 'undefined') {
            elements.video.localPreview.setSinkId(e.target.value);
        }
    });
    
    // Control buttons
    elements.controls.video.addEventListener('click', () => {
        const videoTrack = state.localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            elements.controls.video.classList.toggle('active', videoTrack.enabled);
        }
    });
    
    elements.controls.audio.addEventListener('click', () => {
        const audioTrack = state.localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            elements.controls.audio.classList.toggle('active', audioTrack.enabled);
        }
    });
    
    elements.controls.screenShare.addEventListener('click', toggleScreenShare);
    
    elements.controls.background.addEventListener('click', () => {
        const effects = ['none', 'blur', 'virtual'];
        const currentIndex = effects.indexOf(state.backgroundEffect);
        state.backgroundEffect = effects[(currentIndex + 1) % effects.length];
        elements.controls.background.classList.toggle('active', state.backgroundEffect !== 'none');
        applyBackgroundEffect();
    });
    
    elements.controls.endCall.addEventListener('click', endCall);
    
    // Start and new call buttons
    elements.buttons.startCall.addEventListener('click', startCall);
    elements.buttons.newCall.addEventListener('click', () => {
        resetState();
        showScreen('type');
    });
    
    // Error dialog
    document.getElementById('error-close').addEventListener('click', () => {
        document.getElementById('error-dialog').classList.remove('active');
    });
}

// Call Management
async function startCall() {
    try {
        state.callStartTime = Date.now();
        showScreen('call');
        
        // Start duration timer
        setInterval(updateCallDuration, 1000);
        
        // Initialize WebRTC connections based on call type
        if (state.callType === 'group') {
            initializeGroupCall();
        } else if (state.callType === 'live') {
            initializeLiveStream();
        } else {
            initializeP2PCall();
        }
    } catch (error) {
        showError('Call Error', error.message);
    }
}

function endCall() {
    // Stop all tracks
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
    }
    if (state.screenStream) {
        state.screenStream.getTracks().forEach(track => track.stop());
    }
    
    // Close all peer connections
    state.peerConnections.forEach(pc => pc.close());
    state.peerConnections.clear();
    
    // Update UI
    showScreen('end');
    
    // Send end call signal to peers
    broadcastToPeers({ type: 'end' });
}

function resetState() {
    state.localStream = null;
    state.screenStream = null;
    state.peerConnections.clear();
    state.callType = null;
    state.isHost = false;
    state.participants.clear();
    state.isLive = false;
    state.viewerCount = 0;
    state.likeCount = 0;
    state.callStartTime = null;
    state.backgroundEffect = 'none';
    state.layout = 'grid';
}

// Utility Functions
function hasGPU() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    return !!gl;
}

function sendToPeer(peerId, data) {
    // Implement your signaling mechanism here
    // This could be WebSocket, Firebase, or any other real-time communication method
    console.log('Sending to peer:', peerId, data);
}

function broadcastToPeers(data) {
    state.peerConnections.forEach((_, peerId) => {
        sendToPeer(peerId, data);
    });
}

// Initialize the application
document.addEventListener('DOMContentLoaded', initializeApp);
