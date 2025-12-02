import React, { useState, useEffect, useRef, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged
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
  query,
  where
} from 'firebase/firestore';
import { 
  Mic, MicOff, Video, VideoOff, Monitor, MessageSquare, 
  LogOut, Send, X, Copy, Upload, Activity, Volume2
} from 'lucide-react';

/* --- Firebase Config --- */
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
    const setOn = () => setIsOnline(true);
    const setOff = () => setIsOnline(false);
    window.addEventListener('online', setOn);
    window.addEventListener('offline', setOff);
    return () => {
      window.removeEventListener('online', setOn);
      window.removeEventListener('offline', setOff);
    };
  }, []);
  return isOnline;
};

/* --- MESH NETWORK MANAGER --- */
/* This hook manages connections to EVERY user in the room. 
   It handles Camera, Mic, AND the Movie Stream (Owner Only) */
const useMeshNetwork = (roomId, userId, activeUsers, localStream, movieStream) => {
  const [peers, setPeers] = useState({}); // { [uid]: { stream: MediaStream, isMovie: boolean } }
  const pcs = useRef({}); // PeerConnections
  
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // 1. Manage Connections based on Active Users
  useEffect(() => {
    if (!roomId || !userId) return;

    activeUsers.forEach(u => {
      if (u.uid === userId) return;
      if (!pcs.current[u.uid]) {
        createPeerConnection(u.uid, u.uid < userId); // Simple rule: Lower ID sends offer (polite/impolite pattern)
      }
    });

    // Cleanup dropped users
    Object.keys(pcs.current).forEach(uid => {
      if (!activeUsers.find(u => u.uid === uid)) {
        pcs.current[uid].close();
        delete pcs.current[uid];
        setPeers(prev => {
          const newPeers = { ...prev };
          delete newPeers[uid];
          return newPeers;
        });
      }
    });
  }, [activeUsers, roomId, userId]);

  // 2. Handle Tracks (Updating streams when they change)
  useEffect(() => {
    Object.values(pcs.current).forEach(pc => {
      const senders = pc.getSenders();
      
      // Remove old tracks
      senders.forEach(s => pc.removeTrack(s));

      // Add Local Media (Cam/Mic)
      if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      // Add Movie (Owner Only) - Sent as a second stream or track
      if (movieStream) {
        movieStream.getTracks().forEach(track => pc.addTrack(track, movieStream));
      }
      
      // If we are adding tracks to an existing connection, we might need to renegotiate.
      // For simplicity in this demo, we assume the initial negotiation covers it or relies on "negotiationneeded"
    });
  }, [localStream, movieStream]);

  // 3. Create Connection Logic
  const createPeerConnection = (targetId, isInitiator) => {
    const pc = new RTCPeerConnection(rtcConfig);
    pcs.current[targetId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(targetId, 'ice', event.candidate);
      }
    };

    pc.ontrack = (event) => {
      // Determine if this is a cam or movie based on track characteristics or metadata
      // For this simple version: We assume stream[0] is Cam, stream[1] is Movie (if present)
      // Or we store all streams.
      setPeers(prev => ({
        ...prev,
        [targetId]: { streams: event.streams }
      }));
    };

    // Handling Negotiation
    pc.onnegotiationneeded = async () => {
      if (!isInitiator) return; // Only one side negotiates to avoid collisions
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(targetId, 'offer', offer);
      } catch (err) { console.error("Negotiation error", err); }
    };

    // Initial setup if we are the designated initiator
    if (isInitiator) {
       // We rely on 'onnegotiationneeded' to fire after tracks are added
    }
  };

  // 4. Signaling Listener
  useEffect(() => {
    if (!roomId || !userId) return;
    const q = query(
      collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomId}_signals`),
      where('to', '==', userId)
    );

    const unsub = onSnapshot(q, async (snap) => {
      snap.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const { from, type, payload } = change.doc.data();
          deleteDoc(change.doc.ref); // Consume signal

          let pc = pcs.current[from];
          if (!pc) {
            createPeerConnection(from, false);
            pc = pcs.current[from];
          }

          try {
            if (type === 'offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(payload));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              sendSignal(from, 'answer', answer);
            } 
            else if (type === 'answer') {
              if (pc.signalingState !== 'stable') {
                await pc.setRemoteDescription(new RTCSessionDescription(payload));
              }
            } 
            else if (type === 'ice') {
              if (payload) await pc.addIceCandidate(new RTCIceCandidate(payload));
            }
          } catch (e) { console.warn("Signal error", e); }
        }
      });
    });
    return () => unsub();
  }, [roomId, userId]);

  const sendSignal = async (to, type, payload) => {
    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomId}_signals`), {
      to, from: userId, type, payload: JSON.parse(JSON.stringify(payload)), timestamp: serverTimestamp()
    });
  };

  return peers;
};


/* --- MAIN APP --- */
export default function PArcApp() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('landing');
  const [isOwner, setIsOwner] = useState(false);
  const [sessionId] = useState(() => Math.random().toString(36).slice(2));
  const isOnline = useConnectionStatus();

  // Data
  const [roomData, setRoomData] = useState({ id: '', username: '', color: 'bg-blue-500' });
  const [activeUsers, setActiveUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  
  // Local Media State
  const [localStream, setLocalStream] = useState(null);
  const [movieStream, setMovieStream] = useState(null); // Owner only
  const [mediaState, setMediaState] = useState({ mic: true, cam: false });
  const [movieFile, setMovieFile] = useState(null); // For Owner UI logic

  // Refs
  const localVideoRef = useRef(null);
  const movieVideoRef = useRef(null);
  const msgsEndRef = useRef(null);

  // Mesh Network
  const peers = useMeshNetwork(roomData.id, user?.uid, activeUsers, localStream, movieStream);

  // --- Auth ---
  useEffect(() => {
    signInAnonymously(auth).catch(e => console.error(e));
    return onAuthStateChanged(auth, setUser);
  }, []);

  // --- Room Data Sync ---
  useEffect(() => {
    if (!user || view !== 'room') return;

    // Register User
    const userRef = doc(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_users`, user.uid);
    setDoc(userRef, {
      uid: user.uid,
      name: roomData.username,
      color: roomData.color,
      isOwner,
      sessionId,
      joinedAt: serverTimestamp()
    });

    // Listeners
    const unsubUsers = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_users`), 
      (s) => setActiveUsers(s.docs.map(d => d.data()))
    );
    const unsubMsgs = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_messages`), 
      (s) => {
        const m = s.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b) => (a.createdAt?.seconds||0)-(b.createdAt?.seconds||0));
        setMessages(m);
        setTimeout(() => msgsEndRef.current?.scrollIntoView({behavior:'smooth'}), 100);
      }
    );

    return () => { unsubUsers(); unsubMsgs(); };
  }, [user, view, roomData.id]);

  // --- Local Media Handling ---
  useEffect(() => {
    if (view !== 'room') return;

    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: true
    }).then(stream => {
      setLocalStream(stream);
      // Apply initial state
      stream.getAudioTracks().forEach(t => t.enabled = mediaState.mic);
      stream.getVideoTracks().forEach(t => t.enabled = mediaState.cam);
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    }).catch(e => console.error("Media Access Error", e));

    return () => {
      if (localStream) localStream.getTracks().forEach(t => t.stop());
    };
  }, [view]);

  // Toggle Media
  const toggleMic = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(t => t.enabled = !mediaState.mic);
      setMediaState(p => ({...p, mic: !p.mic}));
    }
  };
  const toggleCam = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(t => t.enabled = !mediaState.cam);
      setMediaState(p => ({...p, cam: !p.cam}));
    }
  };

  // --- Movie Handling (Owner) ---
  const handleMovieSelect = (e) => {
    const file = e.target.files[0];
    if (file && isOwner) {
      const url = URL.createObjectURL(file);
      setMovieFile(url); // Triggers video element render
    }
  };

  // Capture stream when movie starts playing
  const onMoviePlay = () => {
    if (movieVideoRef.current && !movieStream) {
      const stream = movieVideoRef.current.captureStream ? 
                     movieVideoRef.current.captureStream() : 
                     movieVideoRef.current.mozCaptureStream();
      setMovieStream(stream);
    }
  };

  // --- Actions ---
  const sendMessage = (e) => {
    e.preventDefault();
    const input = e.target.elements.msg.value;
    if (!input.trim()) return;
    addDoc(collection(db, 'artifacts', appId, 'public', 'data', `parc_v2_${roomData.id}_messages`), {
      text: input, senderId: user.uid, senderName: roomData.username, createdAt: serverTimestamp()
    });
    e.target.reset();
  };

  // --- Rendering Helpers ---
  const UserBubble = ({ u, isLocal }) => {
    const peerData = peers[u.uid];
    // Find the camera stream (usually the first one, or the one with 2 tracks if movie is separate)
    // For simplicity: If peer has streams, use the first one for Cam/Mic
    const stream = isLocal ? localStream : (peerData?.streams?.[0] || null);
    
    // Remote Audio Handling
    useEffect(() => {
      if (!isLocal && stream) {
        const audio = new Audio();
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.volume = 1.0; // Chat volume
        // audio.play().catch(e => console.log("Audio play blocked", e));
        return () => { audio.pause(); audio.srcObject = null; };
      }
    }, [stream, isLocal]);

    return (
      <div className={`relative w-24 h-24 md:w-32 md:h-32 rounded-xl overflow-hidden bg-slate-800 border-2 ${u.isOwner ? 'border-blue-500' : 'border-slate-700'} shadow-lg shrink-0`}>
        {/* Video Layer */}
        <video 
          ref={el => { if(el && stream) el.srcObject = stream; }}
          autoPlay muted={isLocal} playsInline 
          className={`w-full h-full object-cover ${isLocal ? 'scale-x-[-1]' : ''}`}
        />
        
        {/* Fallback Initial */}
        {(!stream || !stream.getVideoTracks().some(t => t.enabled)) && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-800 text-white font-bold text-xl">
            {u.name[0].toUpperCase()}
          </div>
        )}

        {/* Name Tag */}
        <div className="absolute bottom-0 w-full bg-black/60 text-[10px] text-white p-1 text-center truncate">
          {isLocal ? 'You' : u.name}
        </div>
      </div>
    );
  };

  /* --- VIEW: LANDING --- */
  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="bg-slate-900 p-8 rounded-2xl border border-slate-800 shadow-2xl max-w-md w-full space-y-6">
          <h1 className="text-4xl font-black text-white text-center mb-8">P-Arc</h1>
          <input 
            className="w-full bg-slate-950 border border-slate-700 p-4 rounded-xl text-white" 
            placeholder="Display Name"
            onChange={e => setRoomData({...roomData, username: e.target.value})}
          />
          <div className="grid grid-cols-2 gap-4">
            <button 
              disabled={!roomData.username}
              onClick={() => {
                const id = Math.random().toString(36).slice(2, 8);
                setRoomData(p => ({...p, id})); setIsOwner(true); setView('room');
              }}
              className="bg-blue-600 hover:bg-blue-500 text-white p-4 rounded-xl font-bold disabled:opacity-50"
            >Create Room</button>
            
            <div className="flex flex-col gap-2">
              <input 
                className="bg-slate-950 border border-slate-700 p-2 rounded-lg text-white text-center" 
                placeholder="Room ID"
                onChange={e => setRoomData({...roomData, id: e.target.value})}
              />
              <button 
                disabled={!roomData.username || !roomData.id}
                onClick={() => { setIsOwner(false); setView('room'); }}
                className="bg-slate-800 text-white p-2 rounded-lg font-bold disabled:opacity-50"
              >Join</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* --- VIEW: ROOM --- */
  return (
    <div className="h-screen bg-black flex flex-col overflow-hidden text-slate-200">
      {/* Header */}
      <div className="h-14 bg-slate-900 border-b border-slate-800 flex justify-between items-center px-4 shrink-0">
        <div className="flex items-center gap-4">
          <div className="font-bold text-white">Room: <span className="text-blue-400 font-mono">{roomData.id}</span></div>
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isOnline?'bg-green-500':'bg-red-500'}`}/>
            {activeUsers.length} Online
          </div>
        </div>
        <button onClick={() => setView('landing')} className="text-red-400 hover:bg-slate-800 p-2 rounded"><LogOut size={18}/></button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Main Stage */}
        <div className="flex-1 relative flex flex-col bg-black">
          
          {/* Movie Area */}
          <div className="flex-1 flex items-center justify-center p-4 relative">
            {/* If Owner: Local Player */}
            {isOwner && movieFile ? (
              <video 
                ref={movieVideoRef}
                src={movieFile}
                controls 
                onPlay={onMoviePlay}
                className="max-w-full max-h-full rounded-lg shadow-2xl"
              />
            ) : null}

            {/* If Owner No File */}
            {isOwner && !movieFile && (
              <label className="cursor-pointer bg-slate-800 p-8 rounded-2xl border border-slate-700 flex flex-col items-center gap-4 hover:bg-slate-750 transition-colors">
                <Upload size={48} className="text-blue-500"/>
                <span className="text-white font-bold">Select Movie File</span>
                <input type="file" accept="video/*" className="hidden" onChange={handleMovieSelect} />
              </label>
            )}

            {/* If Guest: Remote Movie Stream */}
            {!isOwner && (
              <div className="w-full h-full flex items-center justify-center">
                {/* Find the stream from the owner that has > 1 video track or is the second stream */}
                {(() => {
                  const owner = activeUsers.find(u => u.isOwner);
                  const ownerData = owner ? peers[owner.uid] : null;
                  // Heuristic: The movie stream is likely the second stream in the array if multiple exist, 
                  // OR we check tracks. For this simple mesh, we assume streams[1] is movie if it exists.
                  const remoteMovieStream = ownerData?.streams?.[1] || (ownerData?.streams?.[0]?.getVideoTracks().length > 1 ? ownerData.streams[0] : null);
                  
                  if (remoteMovieStream) {
                    return (
                      <video 
                        ref={el => {if(el) el.srcObject = remoteMovieStream}} 
                        autoPlay controls className="max-w-full max-h-full rounded-lg"
                      />
                    );
                  }
                  return (
                    <div className="text-center text-slate-500">
                      <Activity size={48} className="mx-auto mb-4 animate-pulse"/>
                      <p>Waiting for broadcast...</p>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* User Bar (Mesh Grid) */}
          <div className="h-32 bg-slate-950 border-t border-slate-900 p-2 flex gap-2 overflow-x-auto items-center">
             {/* Self */}
             <UserBubble u={{...user, name: 'You', isOwner}} isLocal={true} />
             
             {/* Remote Users */}
             {activeUsers.filter(u => u.uid !== user?.uid).map(u => (
               <UserBubble key={u.uid} u={u} isLocal={false} />
             ))}
          </div>

          {/* Controls */}
          <div className="h-16 bg-slate-900 border-t border-slate-800 flex justify-center items-center gap-6">
             <button onClick={toggleMic} className={`p-3 rounded-full ${mediaState.mic ? 'bg-slate-700 text-white' : 'bg-red-500/20 text-red-500'}`}>
               {mediaState.mic ? <Mic/> : <MicOff/>}
             </button>
             <button onClick={toggleCam} className={`p-3 rounded-full ${mediaState.cam ? 'bg-slate-700 text-white' : 'bg-red-500/20 text-red-500'}`}>
               {mediaState.cam ? <Video/> : <VideoOff/>}
             </button>
             {isOwner && (
               <label className="p-3 bg-blue-600 rounded-full text-white cursor-pointer hover:bg-blue-500">
                 <Upload size={24} />
                 <input type="file" accept="video/*" className="hidden" onChange={handleMovieSelect} />
               </label>
             )}
          </div>
        </div>

        {/* Chat Sidebar */}
        <div className="w-80 bg-slate-950 border-l border-slate-900 flex flex-col">
          <div className="p-4 border-b border-slate-900 font-bold text-slate-400">CHAT</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map(m => (
              <div key={m.id} className="bg-slate-900 p-3 rounded-lg border border-slate-800">
                <div className="text-xs font-bold text-blue-400 mb-1">{m.senderName}</div>
                <div className="text-sm text-slate-200 break-words">{m.text}</div>
              </div>
            ))}
            <div ref={msgsEndRef} />
          </div>
          <form onSubmit={sendMessage} className="p-4 border-t border-slate-900 flex gap-2">
            <input name="msg" className="flex-1 bg-slate-900 rounded-full px-4 text-sm text-white focus:outline-none border border-slate-800" placeholder="Type..." />
            <button className="bg-blue-600 p-2 rounded-full text-white"><Send size={16}/></button>
          </form>
        </div>
      </div>
    </div>
  );
}