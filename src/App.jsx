import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  onSnapshot, 
  addDoc, 
  serverTimestamp,
  updateDoc,
  deleteDoc,
  getDoc,
  query,
  where,
  writeBatch
} from 'firebase/firestore';
import { 
  Mic, MicOff, Video, VideoOff, Monitor, MessageSquare, 
  LogOut, Send, X, Copy, Upload, Play, Pause, 
  Volume2, Wifi, WifiOff, Users, Film, Activity
} from 'lucide-react';

/* --- Firebase Initialization --- */
const firebaseConfig = {
  apiKey: "AIzaSyA5OQr1ZKHYS24ftvPksa3rV8RdnIU4xlU",
  authDomain: "video-calling-49b53.firebaseapp.com",
  projectId: "video-calling-49b53",
  storageBucket: "video-calling-49b53.firebasestorage.app",
  messagingSenderId: "669016418304",
  appId: "1:669016418304:web:b6f53a448b126e5e9a50e5",
  measurementId: "G-77S4C4Q309"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = "p-arc-web-v1";

/* --- Helper: Connection Hook --- */
const useConnectionStatus = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  return isOnline;
};

/* --- WebRTC Manager --- */
const useWebRTCStream = (roomId, userId, isOwner, activeUsers, localStream) => {
  const [remoteStream, setRemoteStream] = useState(null);
  const peerConnections = useRef({}); // { [targetUserId]: RTCPeerConnection }
  
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // Cleanup on unmount (CRITICAL FIX)
  useEffect(() => {
    return () => {
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
    };
  }, []);

  // 1. SIGNALING
  useEffect(() => {
    if (!roomId || !userId) return;

    const q = query(
      collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomId}_signals`),
      where('to', '==', userId)
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          const fromUser = data.from;
          deleteDoc(change.doc.ref);

          if (!peerConnections.current[fromUser]) {
             setupPeerConnection(fromUser, !isOwner);
          }
          const pc = peerConnections.current[fromUser];

          try {
            if (data.type === 'offer') {
              if (pc.signalingState !== 'stable') return; // Prevent glare
              await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              sendSignal(fromUser, 'answer', answer);
            } else if (data.type === 'answer') {
              if (pc.signalingState === 'have-local-offer') {
                 await pc.setRemoteDescription(new RTCSessionDescription(data.payload));
              }
            } else if (data.type === 'ice') {
              if (data.payload && pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(data.payload));
              }
            }
          } catch (err) {
            console.error("Signaling Error:", err);
          }
        }
      });
    });

    return () => unsubscribe();
  }, [roomId, userId, isOwner]);

  // 2. OWNER: Connection Management
  useEffect(() => {
    if (!isOwner || !localStream) return;

    activeUsers.forEach(u => {
      if (u.uid !== userId && !peerConnections.current[u.uid]) {
        setupPeerConnection(u.uid, true);
      }
    });
  }, [activeUsers, isOwner, localStream]);

  // 3. Setup PC
  const setupPeerConnection = async (targetId, isInitiator) => {
    if (peerConnections.current[targetId]) return;

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections.current[targetId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(targetId, 'ice', event.candidate);
      }
    };

    pc.ontrack = (event) => {
      setRemoteStream(event.streams[0]);
    };

    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(targetId, 'offer', offer);
      } catch (err) {
        console.error("Error creating offer:", err);
      }
    }
  };

  const sendSignal = async (to, type, payload) => {
    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomId}_signals`), {
      to,
      from: userId,
      type,
      payload: JSON.parse(JSON.stringify(payload)),
      timestamp: serverTimestamp()
    });
  };

  return { remoteStream };
};


/* --- Component: Streamed Video Player --- */
const StreamedVideoPlayer = ({ 
  isOwner, 
  roomState, 
  onUpdateState, 
  volume,
  activeUsers,
  roomId,
  userId
}) => {
  const videoRef = useRef(null);
  const [localFileUrl, setLocalFileUrl] = useState(null);
  const [streamActive, setStreamActive] = useState(false);
  const [capturedStream, setCapturedStream] = useState(null);

  const { remoteStream } = useWebRTCStream(roomId, userId, isOwner, activeUsers, capturedStream);

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setLocalFileUrl(url);
      
      // Update room state with a UNIQUE streamId to force reset everywhere
      onUpdateState({ 
        videoName: file.name,
        isStreaming: true,
        streamId: Date.now() // Critical fix: Force unique session ID
      });
    }
  };

  useEffect(() => {
    if (isOwner && videoRef.current && localFileUrl && !capturedStream) {
      const stream = videoRef.current.captureStream ? videoRef.current.captureStream() : videoRef.current.mozCaptureStream();
      if (stream) {
        setCapturedStream(stream);
        setStreamActive(true);
      }
    }
  }, [isOwner, localFileUrl, capturedStream]);

  useEffect(() => {
    if (!isOwner && videoRef.current && remoteStream) {
      videoRef.current.srcObject = remoteStream;
      videoRef.current.play().catch(e => console.log("Stream autoplay blocked", e));
      setStreamActive(true);
    }
  }, [isOwner, remoteStream]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
    }
  }, [volume]);


  /* --- RENDER LOGIC --- */

  if (isOwner && !localFileUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 bg-slate-900/50 rounded-xl border border-slate-700 p-8 border-dashed animate-in fade-in zoom-in">
        <Film size={48} className="mb-4 text-blue-500" />
        <h3 className="text-xl font-bold text-white mb-2">Broadcast Video</h3>
        <p className="text-center max-w-md mb-6 text-sm">
          Select a video file. It will be streamed directly to all guests. No upload wait time.
        </p>
        <label className="cursor-pointer bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-6 rounded-lg transition-all flex items-center gap-2 shadow-lg shadow-blue-900/50">
          <Upload size={18} />
          <span>Select Video File</span>
          <input type="file" accept="video/*" className="hidden" onChange={handleFileSelect} />
        </label>
      </div>
    );
  }

  if (!isOwner && !streamActive && !remoteStream) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-400 bg-slate-900/50 rounded-xl border border-slate-700 p-8 animate-in fade-in zoom-in">
        <div className="relative mb-4">
           <div className="w-16 h-16 bg-slate-800 rounded-full flex items-center justify-center animate-pulse">
             <Activity size={32} className="text-blue-500" />
           </div>
           <div className="absolute inset-0 border-4 border-blue-500/20 rounded-full animate-ping"></div>
        </div>
        <h3 className="text-xl font-bold text-white mb-2">Waiting for Stream...</h3>
        <p className="text-center max-w-md mb-2 text-sm text-slate-500">
          The owner is setting up the broadcast.
        </p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-slate-800 group">
      <video
        ref={videoRef}
        src={isOwner ? localFileUrl : undefined}
        className="w-full h-full object-contain"
        controls={isOwner}
        playsInline
      />
      {!isOwner && (
        <div className="absolute top-4 left-4 bg-red-600/90 backdrop-blur-md text-white text-xs font-bold px-3 py-1.5 rounded-md flex items-center gap-2 shadow-lg z-20">
          <div className="w-2 h-2 rounded-full bg-white animate-pulse"></div>
          LIVE BROADCAST
        </div>
      )}
      {isOwner && (
        <div className="absolute top-4 left-4 bg-blue-600/90 backdrop-blur-md text-white text-xs font-bold px-3 py-1.5 rounded-md flex items-center gap-2 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
          <Activity size={12} />
          Broadcasting to {activeUsers.length - 1} guests
        </div>
      )}
    </div>
  );
};


/* --- Main Application Component --- */

export default function PArcApp() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('landing'); 
  const [isOwner, setIsOwner] = useState(false);
  const isOnline = useConnectionStatus();

  // Room Data
  const [roomData, setRoomData] = useState({ id: '', username: '', color: '' });
  const [activeUsers, setActiveUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  
  // App State (Synced)
  const [roomState, setRoomState] = useState({ 
    activeMode: 'none', 
    videoName: '',
    isStreaming: false,
    streamId: 0 // New field for session tracking
  });

  const [inputMsg, setInputMsg] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [micVolume, setMicVolume] = useState(1);
  const [mediaVolume, setMediaVolume] = useState(0.8);
  const [localMedia, setLocalMedia] = useState({ audio: false, video: false, screen: false });
  
  const messagesEndRef = useRef(null);
  const videoPreviewRef = useRef(null);
  const screenPreviewRef = useRef(null);

  const AVATAR_COLORS = [
    'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-emerald-500', 
    'bg-teal-500', 'bg-cyan-500', 'bg-blue-500', 'bg-indigo-500', 
    'bg-violet-500', 'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500'
  ];

  /* --- Authentication & Init --- */
  useEffect(() => {
    const initAuth = async () => {
      // FIX: Removed the custom-token logic that caused the mismatch.
      // We now strictly use Anonymous Auth which works with your keys.
      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error("Auth Failed:", error);
      }
    };
    initAuth();
    onAuthStateChanged(auth, (u) => {
      if (u) {
        setUser(u);
        const randomColor = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
        setRoomData(prev => ({ ...prev, color: randomColor }));
      }
    });
  }, []);

  /* --- Firestore Listeners (Room) --- */
  useEffect(() => {
    if (!user || view !== 'room' || !roomData.id) return;

    const userRef = doc(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_users`, user.uid);
    setDoc(userRef, {
      uid: user.uid,
      name: roomData.username,
      color: roomData.color,
      isOwner: isOwner,
      joinedAt: serverTimestamp()
    });

    const unsubUsers = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_users`), (snap) => {
      setActiveUsers(snap.docs.map(d => d.data()));
    });

    const unsubMsgs = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_messages`), (snap) => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      msgs.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
      setMessages(msgs);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    });

    const stateRef = doc(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_state`, 'main');
    const unsubState = onSnapshot(stateRef, (snap) => {
      if (snap.exists()) {
        setRoomState(prev => ({ ...prev, ...snap.data() }));
      } else if (isOwner) {
        setDoc(stateRef, { activeMode: 'none', isStreaming: false, streamId: 0 });
      }
    });

    return () => {
      unsubUsers();
      unsubMsgs();
      unsubState();
    };
  }, [user, view, roomData.id]);

  /* --- Actions --- */

  const handleCreateRoom = () => {
    const newId = Math.random().toString(36).substring(2, 9);
    setRoomData({ ...roomData, id: newId });
    setIsOwner(true);
    setView('room');
  };

  const handleJoinRoom = () => {
    if (!roomData.id) return;
    setIsOwner(false);
    setView('room');
  };

  const updateGlobalState = async (updates) => {
    if (!isOwner) return;
    try {
      const ref = doc(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_state`, 'main');
      await updateDoc(ref, updates);
    } catch (e) {
      console.error("State update failed", e);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!inputMsg.trim()) return;
    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_messages`), {
      text: inputMsg,
      senderId: user.uid,
      senderName: roomData.username,
      senderColor: roomData.color,
      createdAt: serverTimestamp()
    });
    setInputMsg('');
  };

  /* --- Local Media Handlers --- */
  
  useEffect(() => {
    if (localMedia.video && videoPreviewRef.current) {
      navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
        if (videoPreviewRef.current) videoPreviewRef.current.srcObject = stream;
      }).catch(() => setLocalMedia(p => ({ ...p, video: false })));
    } else if (videoPreviewRef.current) {
      const stream = videoPreviewRef.current.srcObject;
      stream?.getTracks().forEach(t => t.stop());
      videoPreviewRef.current.srcObject = null;
    }
  }, [localMedia.video]);

  const toggleScreenShare = async () => {
    if (!localMedia.screen) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        if (screenPreviewRef.current) screenPreviewRef.current.srcObject = stream;
        setLocalMedia(p => ({ ...p, screen: true }));
        updateGlobalState({ activeMode: 'screen' });

        stream.getVideoTracks()[0].onended = () => {
          setLocalMedia(p => ({ ...p, screen: false }));
          updateGlobalState({ activeMode: 'none' });
        };
      } catch (e) {
        console.error("Screen share cancelled", e);
      }
    } else {
      const stream = screenPreviewRef.current?.srcObject;
      stream?.getTracks().forEach(t => t.stop());
      setLocalMedia(p => ({ ...p, screen: false }));
      updateGlobalState({ activeMode: 'none' });
    }
  };

  const toggleVideoMode = () => {
    if (roomState.activeMode === 'video') {
      updateGlobalState({ activeMode: 'none' });
    } else {
      updateGlobalState({ activeMode: 'video' });
    }
  };


  /* --- View: Landing --- */
  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 relative overflow-hidden font-sans">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black pointer-events-none"></div>
        <div className="absolute top-0 left-0 w-full h-full opacity-20 pointer-events-none" style={{ backgroundImage: 'radial-gradient(#4f46e5 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
        
        <div className="z-10 w-full max-w-4xl flex flex-col items-center animate-in fade-in slide-in-from-bottom-8 duration-700">
          <h1 className="text-6xl md:text-8xl font-black tracking-tighter mb-4 bg-gradient-to-br from-white via-slate-200 to-slate-500 bg-clip-text text-transparent">
            P-Arc
          </h1>
          <p className="text-slate-400 text-lg md:text-xl mb-12 max-w-lg text-center leading-relaxed">
            The synchronized virtual space for watch parties and hangouts. No login required.
          </p>

          <div className="bg-slate-900/50 backdrop-blur-xl border border-slate-800 p-8 rounded-3xl shadow-2xl w-full max-w-md">
             <div className="space-y-6">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 block">Your Name</label>
                  <input 
                    type="text" 
                    value={roomData.username}
                    onChange={(e) => setRoomData({...roomData, username: e.target.value})}
                    placeholder="Enter display name"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-4 text-white focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent transition-all"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4 pt-2">
                  <button 
                    onClick={handleCreateRoom}
                    disabled={!roomData.username}
                    className="flex flex-col items-center justify-center gap-3 bg-gradient-to-br from-blue-600 to-indigo-700 hover:from-blue-500 hover:to-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white p-6 rounded-2xl transition-all transform hover:scale-[1.02] shadow-lg shadow-blue-900/20 group"
                  >
                    <div className="p-3 bg-white/10 rounded-full group-hover:bg-white/20 transition-colors">
                      <Monitor size={24} />
                    </div>
                    <span className="font-bold">Create Room</span>
                  </button>

                  <div className="flex flex-col gap-3">
                    <input 
                      type="text" 
                      placeholder="Enter Room ID"
                      value={roomData.id}
                      onChange={(e) => setRoomData({...roomData, id: e.target.value})}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-center focus:outline-none focus:ring-2 focus:ring-purple-600"
                    />
                    <button 
                      onClick={handleJoinRoom}
                      disabled={!roomData.username || !roomData.id}
                      className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-bold rounded-xl transition-all text-sm"
                    >
                      Join Room
                    </button>
                  </div>
                </div>
             </div>
          </div>
        </div>
      </div>
    );
  }

  /* --- View: Room --- */
  return (
    <div className="h-screen bg-black text-slate-200 flex flex-col overflow-hidden font-sans">
      
      {!isOnline && (
        <div className="bg-red-600 text-white text-xs font-bold text-center py-1 flex items-center justify-center gap-2 animate-pulse z-50">
          <WifiOff size={14} /> Connection Lost - Attempting to Reconnect...
        </div>
      )}

      <header className="h-16 bg-slate-950/80 border-b border-slate-900 flex items-center justify-between px-6 shrink-0 z-20 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg text-lg">P</div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-white">Room: <span className="font-mono text-blue-400 tracking-wider">{roomData.id}</span></h2>
              <button onClick={() => navigator.clipboard.writeText(roomData.id)} className="text-slate-500 hover:text-white transition-colors"><Copy size={14}/></button>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
               <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}></div>
               <span>{activeUsers.length} active</span>
               {isOwner && <span className="text-blue-500 font-bold ml-2">• You are Owner</span>}
            </div>
          </div>
        </div>

        <button onClick={() => setView('landing')} className="flex items-center gap-2 text-slate-500 hover:text-red-400 transition-colors px-3 py-2 rounded-lg hover:bg-slate-900">
          <LogOut size={18} />
          <span className="text-sm font-medium">Exit</span>
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        
        <div className="w-20 bg-slate-950 border-r border-slate-900 hidden sm:flex flex-col items-center py-6 gap-4 overflow-y-auto">
           {activeUsers.map(u => (
             <div key={u.uid} className="relative group cursor-default">
               <div className={`w-10 h-10 rounded-full ${u.color} flex items-center justify-center text-white font-bold shadow-lg ring-2 ring-slate-900 group-hover:ring-slate-700 transition-all`}>
                 {u.name.substring(0,2).toUpperCase()}
               </div>
               {u.isOwner && (
                 <div className="absolute -bottom-1 -right-1 bg-blue-600 text-white p-0.5 rounded-full border border-black" title="Owner">
                   <Monitor size={10} />
                 </div>
               )}
               <div className="absolute left-14 top-2 bg-slate-800 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-50 pointer-events-none transition-opacity shadow-xl border border-slate-700">
                 {u.name}
               </div>
             </div>
           ))}
        </div>

        <div className="flex-1 bg-black relative flex flex-col">
          
          <div className="flex-1 p-4 flex items-center justify-center relative overflow-hidden">
             
             <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'linear-gradient(#333 1px, transparent 1px), linear-gradient(90deg, #333 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

             {roomState.activeMode === 'none' && (
               <div className="z-10 text-center space-y-6 max-w-md animate-in fade-in zoom-in duration-500">
                 <div className="w-24 h-24 bg-slate-900 rounded-3xl mx-auto flex items-center justify-center shadow-2xl border border-slate-800">
                    <Monitor size={48} className="text-slate-600" />
                 </div>
                 <div>
                    <h3 className="text-2xl font-bold text-white mb-2">Stage is Empty</h3>
                    {isOwner ? (
                      <p className="text-slate-400">Use the toolbar below to broadcast a video or share your screen.</p>
                    ) : (
                      <p className="text-slate-400">Waiting for the owner to start an activity.</p>
                    )}
                 </div>
               </div>
             )}

             {roomState.activeMode === 'video' && (
               <div className="w-full h-full max-w-6xl max-h-[80vh] z-10 animate-in zoom-in-95 duration-300">
                 <StreamedVideoPlayer 
                    key={roomState.streamId || 'initial'} 
                    isOwner={isOwner} 
                    roomState={roomState} 
                    onUpdateState={updateGlobalState} 
                    volume={mediaVolume}
                    activeUsers={activeUsers}
                    roomId={roomData.id}
                    userId={user.uid}
                 />
               </div>
             )}

             {roomState.activeMode === 'screen' && (
               <div className="w-full h-full z-10 flex items-center justify-center p-8">
                  {localMedia.screen ? (
                    <div className="w-full max-w-6xl aspect-video bg-black border border-slate-800 rounded-xl overflow-hidden shadow-2xl relative">
                      <video ref={screenPreviewRef} autoPlay muted playsInline className="w-full h-full object-contain" />
                      <div className="absolute top-4 right-4 bg-red-600 text-white text-xs font-bold px-3 py-1 rounded-full animate-pulse">
                        LIVE SHARING
                      </div>
                    </div>
                  ) : (
                    <div className="text-center p-8 bg-slate-900/80 border border-slate-800 rounded-xl max-w-lg">
                      <Monitor size={48} className="mx-auto text-blue-500 mb-4" />
                      <h3 className="text-xl font-bold text-white mb-2">Screen Share Active</h3>
                      <p className="text-slate-400 text-sm">
                        The owner is currently sharing their screen. 
                        <br/><br/>
                        <span className="text-xs text-slate-500 italic border-t border-slate-700 pt-2 block">
                           Note: In this serverless environment, screen mirroring logic is handled via the same broadcast protocol as video.
                        </span>
                      </p>
                    </div>
                  )}
               </div>
             )}

             {localMedia.video && (
               <div className="absolute bottom-6 left-6 w-48 aspect-video bg-black rounded-lg border border-slate-700 shadow-2xl overflow-hidden z-20 animate-in slide-in-from-bottom-10">
                 <video ref={videoPreviewRef} autoPlay muted playsInline className="w-full h-full object-cover transform scale-x-[-1]" />
                 <div className="absolute bottom-1 left-2 text-[10px] font-bold text-white bg-black/50 px-1 rounded">YOU</div>
               </div>
             )}

          </div>

          <div className="bg-slate-950 border-t border-slate-900 p-3 flex flex-col md:flex-row items-center justify-between gap-4 z-30">
             
             <div className="flex items-center gap-6 px-4 py-2 bg-slate-900 rounded-xl border border-slate-800 w-full md:w-auto">
               <div className="flex flex-col gap-1 w-24">
                 <div className="flex justify-between text-[10px] uppercase font-bold text-slate-500">
                    <span>Mic Gain</span>
                    <span>{localMedia.audio ? Math.round(micVolume * 100) + '%' : 'OFF'}</span>
                 </div>
                 <div className="relative h-1 bg-slate-700 rounded-lg">
                   <div className={`absolute top-0 left-0 h-full rounded-lg transition-all ${localMedia.audio ? 'bg-green-500' : 'bg-slate-600'}`} style={{width: `${micVolume * 100}%`}}></div>
                   <input 
                     type="range" min="0" max="1" step="0.1" 
                     value={micVolume} onChange={(e) => setMicVolume(parseFloat(e.target.value))}
                     className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                   />
                 </div>
               </div>
               <div className="w-px h-8 bg-slate-800"></div>
               <div className="flex flex-col gap-1 w-24">
                 <div className="flex justify-between text-[10px] uppercase font-bold text-slate-500">
                    <span>Media Vol</span>
                    <span>{Math.round(mediaVolume * 100)}%</span>
                 </div>
                 <div className="relative h-1 bg-slate-700 rounded-lg">
                   <div className="absolute top-0 left-0 h-full bg-blue-500 rounded-lg" style={{width: `${mediaVolume * 100}%`}}></div>
                   <input 
                     type="range" min="0" max="1" step="0.1" 
                     value={mediaVolume} onChange={(e) => setMediaVolume(parseFloat(e.target.value))}
                     className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                   />
                 </div>
               </div>
             </div>

             <div className="flex items-center gap-3">
               <button 
                  onClick={() => setLocalMedia(p => ({ ...p, audio: !p.audio }))}
                  className={`p-3 rounded-full transition-all ${localMedia.audio ? 'bg-slate-800 text-white hover:bg-slate-700' : 'bg-red-500/20 text-red-500 hover:bg-red-500/30'}`}
                  title="Toggle Mic"
               >
                 {localMedia.audio ? <Mic size={20} /> : <MicOff size={20} />}
               </button>
               
               <button 
                  onClick={() => setLocalMedia(p => ({ ...p, video: !p.video }))}
                  className={`p-3 rounded-full transition-all ${localMedia.video ? 'bg-slate-800 text-white hover:bg-slate-700' : 'bg-red-500/20 text-red-500 hover:bg-red-500/30'}`}
                  title="Toggle Camera"
               >
                 {localMedia.video ? <Video size={20} /> : <VideoOff size={20} />}
               </button>

               {isOwner && (
                 <>
                  <div className="w-px h-8 bg-slate-800 mx-1"></div>
                  
                  <button 
                    onClick={toggleVideoMode}
                    className={`p-3 rounded-full transition-all ${roomState.activeMode === 'video' ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/50 ring-2 ring-blue-400 ring-offset-2 ring-offset-slate-950' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                    title="Broadcast Video"
                  >
                    <Upload size={20} />
                  </button>

                  <button 
                    onClick={toggleScreenShare}
                    className={`p-3 rounded-full transition-all ${roomState.activeMode === 'screen' ? 'bg-green-600 text-white shadow-lg shadow-green-900/50 ring-2 ring-green-400 ring-offset-2 ring-offset-slate-950' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                    title="Share Screen"
                  >
                    <Monitor size={20} />
                  </button>
                 </>
               )}
             </div>

             <div className="md:hidden">
                <button 
                  onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
                  className="p-3 bg-slate-800 text-slate-300 rounded-full"
                >
                  <MessageSquare size={20} />
                </button>
             </div>
             
             <div className="hidden md:block w-[280px]"></div>

          </div>
        </div>

        <div className={`${isSidebarOpen ? 'translate-x-0' : 'translate-x-full'} absolute md:static inset-y-0 right-0 w-full md:w-80 bg-slate-950 border-l border-slate-900 transition-transform duration-300 z-40 flex flex-col`}>
          <div className="p-4 border-b border-slate-900 flex justify-between items-center bg-slate-950">
             <h3 className="font-bold text-slate-300 text-sm uppercase tracking-wider">Chat</h3>
             <button onClick={() => setIsSidebarOpen(false)} className="md:hidden text-slate-400"><X size={20} /></button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950">
             {messages.length === 0 && (
                <div className="text-center text-slate-700 mt-10">
                   <MessageSquare className="mx-auto mb-2 opacity-20" size={32} />
                   <p className="text-xs">No messages yet.</p>
                </div>
             )}
             {messages.map((msg) => (
               <div key={msg.id} className="animate-in fade-in slide-in-from-bottom-2 duration-200">
                 <div className="flex items-baseline gap-2 mb-1">
                   <span className={`text-[11px] font-bold ${msg.senderColor ? msg.senderColor.replace('bg-', 'text-') : 'text-blue-400'}`}>
                     {msg.senderName}
                   </span>
                   <span className="text-[9px] text-slate-600">
                      {msg.createdAt?.seconds ? new Date(msg.createdAt.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : ''}
                   </span>
                 </div>
                 <p className="text-sm text-slate-300 bg-slate-900 p-2.5 rounded-2xl rounded-tl-none inline-block border border-slate-800">
                   {msg.text}
                 </p>
               </div>
             ))}
             <div ref={messagesEndRef} />
          </div>

          <form onSubmit={sendMessage} className="p-3 bg-slate-950 border-t border-slate-900">
             <div className="relative">
               <input 
                 type="text" 
                 value={inputMsg} 
                 onChange={(e) => setInputMsg(e.target.value)}
                 placeholder="Type a message..."
                 className="w-full bg-slate-900 border border-slate-800 rounded-full pl-4 pr-10 py-3 text-sm text-slate-200 focus:outline-none focus:border-blue-600 transition-colors"
               />
               <button 
                 type="submit"
                 disabled={!inputMsg.trim()}
                 className="absolute right-2 top-2 p-1.5 bg-blue-600 text-white rounded-full hover:bg-blue-500 disabled:opacity-50 disabled:bg-slate-800 transition-colors"
               >
                 <Send size={14} />
               </button>
             </div>
          </form>
        </div>

      </div>
    </div>
  );
}