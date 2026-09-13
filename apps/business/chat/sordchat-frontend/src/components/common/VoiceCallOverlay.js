import React, { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Check, MessageSquare, Mic, MicOff, MonitorUp, Pencil, Pin, EyeOff, Phone, PhoneOff, Send, Smile, Video, VideoOff, Volume2 } from "lucide-react";
import toast from "react-hot-toast";
import { useWebSocket } from "../../contexts/WebSocketContext";
import { usePlatformDialog } from "../../contexts/PlatformDialogContext";
import { useAuth } from "../../contexts/AuthContext";

const ICE_SERVERS = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const personName = (person) => person?.nickname || person?.full_name || person?.username || "Usuário";
const newId = (prefix="call") => window.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const deviceMessage = "Não foi reconhecido dispositivo de áudio/microfone para iniciar a ligação.";
const reactionOptions = ["👍", "👏", "❤️", "😂", "🎉", "✋"];

const notifyIncoming = (call) => {
  const group = call.mode !== "direct";
  const payload = { title: call.mediaType === "video" ? "Chamada de vídeo recebida" : "Ligação recebida", body: group ? `${personName(call.host)} convidou você para ${call.title}.` : `${personName(call.host)} está ligando para você.`, senderId: call.host?.id || null };
  if (window.voltChatDesktop?.showNotification) window.voltChatDesktop.showNotification(payload).catch(() => {});
  else if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification(payload.title, { body: payload.body });
};

export default function VoiceCallOverlay() {
  const { user } = useAuth();
  const { voiceSignal, sendVoiceSignal, registerVoiceCallController } = useWebSocket();
  const dialog = usePlatformDialog();
  const [call, setCall] = useState(null), [muted, setMuted] = useState(false), [cameraOff, setCameraOff] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState({}), [screenSharing, setScreenSharing] = useState(false), [panel, setPanel] = useState(null);
  const [hostExitOpen, setHostExitOpen] = useState(false);
  const [roomMessages, setRoomMessages] = useState([]), [chatText, setChatText] = useState(""), [reactions, setReactions] = useState([]);
  const [poll, setPoll] = useState(null), [pollDraft, setPollDraft] = useState({ question:"", options:["",""], duration_seconds:60 }), [annotationLines, setAnnotationLines] = useState([]), [annotating, setAnnotating] = useState(false);
  const [pollNow, setPollNow] = useState(Date.now()), [pinnedPeerId, setPinnedPeerId] = useState(null), [hiddenPeerIds, setHiddenPeerIds] = useState([]);
  const callRef=useRef(null), localStreamRef=useRef(null), localVideoRef=useRef(null), cameraTrackRef=useRef(null), screenTrackRef=useRef(null), peersRef=useRef(new Map()), candidatesRef=useRef(new Map()), joinedRef=useRef(new Map()), drawRef=useRef(null), pollRef=useRef(null), annotationTimersRef=useRef(new Map());
  useEffect(()=>{callRef.current=call},[call]);
  useEffect(()=>{pollRef.current=poll},[poll]);
  useEffect(()=>{if(localVideoRef.current)localVideoRef.current.srcObject=localStreamRef.current},[call,cameraOff,screenSharing]);

  const metadata=useCallback(()=>{const current=callRef.current;return{call_id:current?.id,media_type:current?.mediaType,mode:current?.mode,group_id:current?.groupId||null,meeting_id:current?.meetingId||null,title:current?.title}},[]);
  const targets=useCallback(()=>[...new Set([...(callRef.current?.participants||[]).map(item=>Number(item.id)),Number(callRef.current?.host?.id),...[...joinedRef.current.keys()].map(Number)].filter(id=>id&&id!==Number(user?.id)))],[user?.id]);
  const sendRoomEvent=useCallback((event)=>targets().forEach(id=>sendVoiceSignal(id,"room_event",{...metadata(),event})),[metadata,sendVoiceSignal,targets]);
  const removeAnnotationStroke=useCallback((strokeId,delay=620)=>{
    const currentTimer=annotationTimersRef.current.get(strokeId);
    if(currentTimer)window.clearTimeout(currentTimer);
    setAnnotationLines(lines=>lines.map(item=>item.id===strokeId?{...item,finishing:true}:item));
    const timer=window.setTimeout(()=>{
      setAnnotationLines(lines=>lines.filter(item=>item.id!==strokeId));
      annotationTimersRef.current.delete(strokeId);
    },delay);
    annotationTimersRef.current.set(strokeId,timer);
  },[]);
  const mergeAnnotationStroke=useCallback((event)=>{
    const strokeId=String(event.stroke_id||"");
    if(!strokeId)return;
    const incoming=Array.isArray(event.points)?event.points:[];
    setAnnotationLines(lines=>{
      const existing=lines.find(item=>item.id===strokeId);
      if(!existing)return[...lines,{id:strokeId,points:incoming,color:event.color||"#ef4444",finishing:false}].slice(-40);
      return lines.map(item=>item.id===strokeId?{...item,points:[...item.points,...incoming].slice(-240)}:item);
    });
    if(event.done)removeAnnotationStroke(strokeId);
  },[removeAnnotationStroke]);

  const release=useCallback(()=>{localStreamRef.current?.getTracks().forEach(track=>track.stop());screenTrackRef.current?.stop();localStreamRef.current=null;cameraTrackRef.current=null;screenTrackRef.current=null;peersRef.current.forEach(peer=>peer.close());peersRef.current.clear();candidatesRef.current.clear();joinedRef.current.clear();annotationTimersRef.current.forEach(timer=>window.clearTimeout(timer));annotationTimersRef.current.clear();drawRef.current=null;setRemoteStreams({});setMuted(false);setCameraOff(false);setScreenSharing(false);setPanel(null);setHostExitOpen(false);setRoomMessages([]);pollRef.current=null;setPoll(null);setPinnedPeerId(null);setHiddenPeerIds([]);setAnnotationLines([]);},[]);
  const openMedia = useCallback(async (mediaType, cameraEnabled = true, allowListenOnly = false) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      if (!allowListenOnly) throw Object.assign(new Error(deviceMessage), { code: "AUDIO_DEVICE_NOT_FOUND" });
      const empty = new MediaStream();
      localStreamRef.current = empty;
      setMuted(true);
      setCameraOff(mediaType === "video");
      return empty;
    }
    const video = mediaType === "video" && cameraEnabled
      ? { width: { ideal: 1280 }, height: { ideal: 720 } }
      : false;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (error) {
      if (!allowListenOnly) throw error;
      stream = new MediaStream();
      if (video) {
        try {
          const cameraOnly = await navigator.mediaDevices.getUserMedia({ audio: false, video });
          cameraOnly.getTracks().forEach((track) => stream.addTrack(track));
        } catch {
          try {
            const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            audioOnly.getTracks().forEach((track) => stream.addTrack(track));
          } catch {
            // Sem dispositivos: o participante ainda pode entrar como ouvinte.
          }
        }
      }
    }
    const hasAudio = stream.getAudioTracks().some((track) => track.readyState === "live");
    if (!hasAudio && !allowListenOnly) {
      stream.getTracks().forEach((track) => track.stop());
      throw Object.assign(new Error(deviceMessage), { code: "AUDIO_DEVICE_NOT_FOUND" });
    }
    cameraTrackRef.current = stream.getVideoTracks()[0] || null;
    localStreamRef.current = stream;
    setMuted(!hasAudio);
    setCameraOff(mediaType === "video" && !cameraTrackRef.current);
    if (allowListenOnly && !hasAudio) toast("Você entrou no Meeting como ouvinte.", { icon: "🔇" });
    return stream;
  }, []);
  const flushCandidates=useCallback(async(userId,peer)=>{for(const candidate of candidatesRef.current.get(String(userId))||[])await peer.addIceCandidate(candidate);candidatesRef.current.delete(String(userId))},[]);
  const createPeer=useCallback(participant=>{const key=String(participant.id);if(peersRef.current.has(key))return peersRef.current.get(key);const peer=new RTCPeerConnection(ICE_SERVERS);const localTracks=localStreamRef.current?.getTracks()||[];localTracks.forEach(track=>peer.addTrack(track,localStreamRef.current));if(callRef.current?.mode==="meeting"){if(!localTracks.some(track=>track.kind==="audio"))peer.addTransceiver("audio",{direction:"recvonly"});if(callRef.current.mediaType==="video"&&!localTracks.some(track=>track.kind==="video"))peer.addTransceiver("video",{direction:"recvonly"})}peer.onicecandidate=({candidate})=>{if(candidate)sendVoiceSignal(participant.id,"ice",{...metadata(),candidate:candidate.toJSON()})};peer.ontrack=({streams})=>{if(streams[0])setRemoteStreams(current=>({...current,[key]:{stream:streams[0],participant}}));setCall(current=>current?{...current,status:"connected"}:current)};peer.onconnectionstatechange=()=>{if(["failed","closed"].includes(peer.connectionState)){peersRef.current.delete(key);setRemoteStreams(current=>{const next={...current};delete next[key];return next})}};peersRef.current.set(key,peer);return peer},[metadata,sendVoiceSignal]);
  const offerTo=useCallback(async participant=>{const peer=createPeer(participant),offer=await peer.createOffer();await peer.setLocalDescription(offer);sendVoiceSignal(participant.id,"offer",{...metadata(),description:offer})},[createPeer,metadata,sendVoiceSignal]);

  const startDirect=useCallback(async(participant,mediaType="audio")=>{if(!participant?.id||callRef.current)return false;try{const next={id:newId(),mode:"direct",mediaType,title:personName(participant),host:participant,participants:[participant],status:"calling",direction:"outgoing"};setCall(next);callRef.current=next;await openMedia(mediaType,true);await offerTo(participant);return true}catch(error){release();setCall(null);await dialog.alert({title:"Dispositivo indisponível",message:error?.name==="NotAllowedError"?"Permita o uso de câmera e microfone.":deviceMessage});return false}},[dialog,offerTo,openMedia,release]);
  const startGroup=useCallback(async(group,participants,mediaType="audio",mode="group",options={})=>{
    if(!group?.id||callRef.current)return false;
    try{
      const meetingMode=mode==="meeting";
      const roomParticipants=(participants||[]).filter(person=>Number(person.id)!==Number(user?.id));
      const creatorId=Number(group.creator_user_id||0);
      const roomHost=meetingMode?(creatorId===Number(user?.id)?user:roomParticipants.find(person=>Number(person.id)===creatorId)||null):null;
      const next={id:meetingMode?`meeting-${group.id}`:newId(),mode,mediaType,title:group.title||group.name||"Reunião",groupId:meetingMode?null:(group.group_id||group.id),meetingId:meetingMode?group.id:null,host:roomHost,participants:roomParticipants,status:meetingMode?"waiting":"calling",direction:"outgoing",isHost:meetingMode?creatorId===Number(user?.id):true};
      setCall(next);
      callRef.current=next;
      await openMedia(mediaType,options.camera!==false,meetingMode);
      if(meetingMode){
        joinedRef.current.clear();
        roomParticipants.forEach(person=>sendVoiceSignal(person.id,"meeting_join",{...metadata()}));
      }else{
        roomParticipants.forEach(person=>sendVoiceSignal(person.id,"invite",{call_id:next.id,media_type:mediaType,mode,group_id:next.groupId,meeting_id:next.meetingId,title:next.title}));
      }
      return true;
    }catch(error){release();setCall(null);await dialog.alert({title:"Dispositivo indisponível",message:deviceMessage});return false}
  },[dialog,metadata,openMedia,release,sendVoiceSignal,user]);
  const accept=useCallback(async(cameraEnabled=true)=>{const current=callRef.current;if(!current)return;try{await openMedia(current.mediaType,cameraEnabled,current.mode==="meeting");setCall(value=>({...value,status:"connecting",direction:"incoming"}));if(current.mode==="direct"){const peer=createPeer(current.host);await peer.setRemoteDescription(current.offer);const answer=await peer.createAnswer();await peer.setLocalDescription(answer);sendVoiceSignal(current.host.id,"answer",{...metadata(),description:answer});await flushCandidates(current.host.id,peer)}else sendVoiceSignal(current.host.id,"join",{...metadata()})}catch(error){release();setCall(null);await dialog.alert({title:"Dispositivo indisponível",message:deviceMessage})}},[createPeer,dialog,flushCandidates,metadata,openMedia,release,sendVoiceSignal]);
const finish=useCallback((type="end")=>{targets().forEach(id=>sendVoiceSignal(id,type,{...metadata()}));release();setCall(null)},[metadata,release,sendVoiceSignal,targets]);
  const leaveCall=useCallback(()=>{const current=callRef.current;if(!current)return;if(current.mode==="meeting"&&current.isHost&&current.status!=="calling"){setHostExitOpen(true);return}const type=current.mode==="meeting"?"leave":current.status==="calling"?"cancel":"end";targets().forEach(id=>sendVoiceSignal(id,type,{...metadata()}));release();setCall(null)},[metadata,release,sendVoiceSignal,targets]);
  const transferHost=useCallback(participant=>{const currentTargets=targets();currentTargets.forEach(id=>sendVoiceSignal(id,"host_transfer",{...metadata(),new_host:participant}));currentTargets.forEach(id=>sendVoiceSignal(id,"leave",{...metadata()}));release();setCall(null)},[metadata,release,sendVoiceSignal,targets]);

  useEffect(()=>registerVoiceCallController({start:startDirect,startVideo:person=>startDirect(person,"video"),startGroup:(group,people)=>startGroup(group,people,"audio","group"),startMeetingVideo:(meeting,people,options)=>startGroup(meeting,people,"video","meeting",options)}),[registerVoiceCallController,startDirect,startGroup]);
  useEffect(()=>{const onMeetingDeleted=event=>{if(String(callRef.current?.meetingId)!==String(event.detail?.meeting_id))return;release();setCall(null);toast("Este Meeting foi excluído pelo criador.")};window.addEventListener("voltchat:meeting-deleted",onMeetingDeleted);return()=>window.removeEventListener("voltchat:meeting-deleted",onMeetingDeleted)},[release]);
  useEffect(()=>{
    const data=voiceSignal,sender=data?.from_user,signal=data?.signal||{},type=data?.signal_type;
    if(!type||!sender)return;
    if(type==="invite"){
      if(callRef.current){sendVoiceSignal(sender.id,"decline",signal);return}
      const next={id:signal.call_id,mode:signal.mode||"group",mediaType:signal.media_type||"audio",title:signal.title||"Chamada em grupo",groupId:signal.group_id,meetingId:signal.meeting_id,host:sender,participants:[sender],status:"incoming",direction:"incoming"};
      setCall(next);callRef.current=next;notifyIncoming(next);return;
    }
    if(type==="offer"&&!callRef.current){
      if(signal.mode==="meeting")return;
      const next={id:signal.call_id||newId(),mode:signal.mode||"direct",mediaType:signal.media_type||"audio",title:personName(sender),host:sender,participants:[sender],status:"incoming",direction:"incoming",offer:signal.description||signal};
      setCall(next);callRef.current=next;notifyIncoming(next);return;
    }
    const current=callRef.current;
    if(!current||signal.call_id!==current.id)return;
    const registerParticipant=()=>{
      joinedRef.current.set(String(sender.id),sender);
      setCall(value=>{
        if(!value)return value;
        const next={...value,status:value.status==="waiting"?"connecting":value.status,participants:[...(value.participants||[]).filter(item=>Number(item.id)!==Number(sender.id)),sender]};
        callRef.current=next;
        return next;
      });
    };
    (async()=>{
      if(type==="meeting_join"&&current.mode==="meeting"){
        registerParticipant();
        sendVoiceSignal(sender.id,"meeting_presence",{...metadata(),poll:pollRef.current});
        if(Number(user?.id)<Number(sender.id)&&!peersRef.current.has(String(sender.id)))await offerTo(sender);
        return;
      }
      if(type==="meeting_presence"&&current.mode==="meeting"){
        registerParticipant();
        if(signal.poll){pollRef.current=signal.poll;setPoll(signal.poll);setPanel("poll")}
        if(Number(user?.id)<Number(sender.id)&&!peersRef.current.has(String(sender.id)))await offerTo(sender);
        return;
      }
      if(type==="host_transfer"&&signal.new_host){
        const nextHost=signal.new_host;joinedRef.current.set(String(nextHost.id),nextHost);
        setCall(value=>{if(!value)return value;const next={...value,host:nextHost,isHost:Number(nextHost.id)===Number(user?.id),status:"connected",participants:[...(value.participants||[]).filter(item=>Number(item.id)!==Number(nextHost.id)),nextHost]};callRef.current=next;return next});
        toast.success(Number(nextHost.id)===Number(user?.id)?"Você agora é o anfitrião da reunião.":`${personName(nextHost)} agora é o anfitrião.`);return;
      }
      if(type==="leave"){
        const key=String(sender.id);peersRef.current.get(key)?.close();peersRef.current.delete(key);joinedRef.current.delete(key);
        setRemoteStreams(items=>{const next={...items};delete next[key];return next});
        setCall(value=>{if(!value)return value;const next={...value,participants:(value.participants||[]).filter(item=>Number(item.id)!==Number(sender.id))};callRef.current=next;return next});return;
      }
      if(type==="room_event"){
        const event=signal.event||{};
        if(event.type==="chat")setRoomMessages(items=>[...items,{...event,sender}]);
        if(event.type==="reaction"){
          const id=newId("reaction");setReactions(items=>[...items,{id,emoji:event.emoji,name:personName(sender)}].slice(-5));
          window.setTimeout(()=>setReactions(items=>items.filter(item=>item.id!==id)),2200);
        }
        if(event.type==="poll"){pollRef.current=event.poll;setPoll(event.poll);setPanel("poll")}
        if(event.type==="poll_close")setPoll(currentPoll=>currentPoll?{...currentPoll,closed:true}:currentPoll);
        if(event.type==="vote")setPoll(currentPoll=>currentPoll&&currentPoll.id===event.poll_id?{...currentPoll,options:currentPoll.options.map(option=>option.id===event.option_id&&!option.voters.includes(sender.id)?{...option,voters:[...option.voters,sender.id]}:option)}:currentPoll);
        if(event.type==="annotation_stroke")mergeAnnotationStroke(event);
        if(event.type==="annotation"&&event.line)mergeAnnotationStroke({stroke_id:event.line.id,points:[{x:event.line.x1,y:event.line.y1},{x:event.line.x2,y:event.line.y2}],color:event.line.color,done:true});
        if(event.type==="annotation_clear")setAnnotationLines([]);
        return;
      }
      if(type==="join"&&current.isHost){
        const existing=[...joinedRef.current.values()].filter(item=>Number(item.id)!==Number(sender.id));registerParticipant();await offerTo(sender);existing.forEach(person=>sendVoiceSignal(person.id,"peer",{...metadata(),target_user:sender}));return;
      }
      if(type==="peer"&&signal.target_user){
        joinedRef.current.set(String(signal.target_user.id),signal.target_user);setCall(value=>value?{...value,participants:[...(value.participants||[]).filter(item=>Number(item.id)!==Number(signal.target_user.id)),signal.target_user]}:value);await offerTo(signal.target_user);return;
      }
      if(type==="offer"){
        const peer=createPeer(sender);await peer.setRemoteDescription(signal.description||signal);const answer=await peer.createAnswer();await peer.setLocalDescription(answer);sendVoiceSignal(sender.id,"answer",{...metadata(),description:answer});await flushCandidates(sender.id,peer);registerParticipant();setCall(value=>value?{...value,status:"connected"}:value);return;
      }
      if(type==="answer"){
        const peer=peersRef.current.get(String(sender.id));if(peer){await peer.setRemoteDescription(signal.description||signal);await flushCandidates(sender.id,peer);registerParticipant();setCall(value=>value?{...value,status:"connected"}:value)}return;
      }
      if(type==="ice"&&signal.candidate){
        const peer=peersRef.current.get(String(sender.id)),candidate=new RTCIceCandidate(signal.candidate);if(peer?.remoteDescription)await peer.addIceCandidate(candidate);else candidatesRef.current.set(String(sender.id),[...(candidatesRef.current.get(String(sender.id))||[]),candidate]);return;
      }
      if(["end","cancel","decline"].includes(type)){
        if(current.mode==="direct"||(!current.isHost&&Number(sender.id)===Number(current.host?.id))){release();setCall(null)}else{peersRef.current.get(String(sender.id))?.close();peersRef.current.delete(String(sender.id))}
      }
    })().catch(error=>{console.error("Falha ao conectar participante:",error);toast.error("Falha ao conectar participante.")});
  },[createPeer,flushCandidates,mergeAnnotationStroke,metadata,offerTo,release,sendVoiceSignal,user?.id,voiceSignal]);
  useEffect(()=>()=>release(),[release]);
  useEffect(()=>{if(!poll||poll.closed||!poll.closes_at)return undefined;const timer=window.setInterval(()=>setPollNow(Date.now()),1000);return()=>window.clearInterval(timer)},[poll]);

  const toggleMute = async () => {
    const currentTracks = localStreamRef.current?.getAudioTracks().filter((track) => track.readyState === "live") || [];
    if (currentTracks.length) {
      const next = !muted;
      currentTracks.forEach((track) => { track.enabled = !next; });
      setMuted(next);
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error(deviceMessage);
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const track = microphone.getAudioTracks()[0];
      if (!track) throw new Error(deviceMessage);
      if (!localStreamRef.current) localStreamRef.current = new MediaStream();
      localStreamRef.current.addTrack(track);
      for (const peer of peersRef.current.values()) {
        const transceiver = peer.getTransceivers().find((item) => item.receiver?.track?.kind === "audio");
        if (transceiver) {
          await transceiver.sender.replaceTrack(track);
          transceiver.direction = "sendrecv";
        } else {
          peer.addTrack(track, localStreamRef.current);
        }
        const participant = participantForPeer(peer);
        if (participant) await offerTo(participant);
      }
      setMuted(false);
      toast.success("Microfone ativado.");
    } catch {
      toast.error("Nenhum microfone foi reconhecido ou autorizado.");
    }
  };  const participantForPeer = (peer) => {
    const peerId = [...peersRef.current.entries()].find(([, value]) => value === peer)?.[0];
    return remoteStreams[peerId]?.participant || joinedRef.current.get(peerId);
  };
  const toggleCamera = async () => {
    if (!cameraOff) {
      localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = false; });
      setCameraOff(true);
      return;
    }
    let track = cameraTrackRef.current;
    if (!track || track.readyState !== "live") {
      const camera = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      track = camera.getVideoTracks()[0];
      cameraTrackRef.current = track;
      localStreamRef.current?.addTrack(track);
      for (const peer of peersRef.current.values()) {
        const sender = peer.getSenders().find((item) => item.track?.kind === "video");
        if (sender) await sender.replaceTrack(track);
        else {
          peer.addTrack(track, localStreamRef.current);
          const participant = participantForPeer(peer);
          if (participant) await offerTo(participant);
        }
      }
    }
    track.enabled = true;
    setCameraOff(false);
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
  };
  const stopShare = useCallback(async () => {
    const camera = cameraTrackRef.current;
    for (const peer of peersRef.current.values()) {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) await sender.replaceTrack(camera || null);
    }
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    setScreenSharing(false);
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
  }, []);
  const toggleShare = async () => {
    if (screenSharing) {
      await stopShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast.error("Compartilhamento de tela indisponível.");
      return;
    }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = display.getVideoTracks()[0];
    screenTrackRef.current = track;
    for (const peer of peersRef.current.values()) {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) await sender.replaceTrack(track);
      else {
        peer.addTrack(track, display);
        const participant = participantForPeer(peer);
        if (participant) await offerTo(participant);
      }
    }
    track.onended = stopShare;
    setScreenSharing(true);
    if (localVideoRef.current) localVideoRef.current.srcObject = display;
  };  const sendChat=event=>{event.preventDefault();const text=chatText.trim();if(!text)return;const message={type:"chat",id:newId("chat"),text,created_at:new Date().toISOString(),sender:{id:user?.id,full_name:personName(user)}};setRoomMessages(items=>[...items,message]);sendRoomEvent(message);setChatText("")};
  const react=emoji=>{const id=newId("reaction"),event={type:"reaction",emoji};setReactions(items=>[...items,{id,emoji,name:"Você"}].slice(-5));window.setTimeout(()=>setReactions(items=>items.filter(item=>item.id!==id)),2200);sendRoomEvent(event);setPanel(null)};
  const publishPoll=event=>{event.preventDefault();const options=pollDraft.options.map(label=>label.trim()).filter(Boolean);if(!pollDraft.question.trim()||options.length<2)return;const next={id:newId("poll"),question:pollDraft.question.trim(),duration_seconds:Number(pollDraft.duration_seconds)||60,closes_at:new Date(Date.now()+(Number(pollDraft.duration_seconds)||60)*1000).toISOString(),closed:false,options:options.map(label=>({id:newId("option"),label,voters:[]}))};pollRef.current=next;setPoll(next);setPanel("poll");sendRoomEvent({type:"poll",poll:next});setPollDraft({question:"",options:["",""],duration_seconds:60})};
  const closePoll=()=>{setPoll(current=>current?{...current,closed:true}:current);sendRoomEvent({type:"poll_close"})};
  const vote=optionId=>{if(!poll||poll.options.some(option=>option.voters.includes(user?.id)))return;setPoll(current=>({...current,options:current.options.map(option=>option.id===optionId?{...option,voters:[...option.voters,user?.id]}:option)}));sendRoomEvent({type:"vote",poll_id:poll.id,option_id:optionId})};
  const draw=(event,phase)=>{
    if(!annotating)return;
    if(phase==="start"){
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const rect=event.currentTarget.getBoundingClientRect();
      const point={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
      const stroke={id:newId("stroke"),points:[point],sent:0,lastSentAt:0,color:"#ef4444"};
      drawRef.current=stroke;
      setAnnotationLines(lines=>[...lines,{id:stroke.id,points:[point],color:stroke.color,finishing:false}].slice(-40));
      return;
    }
    const stroke=drawRef.current;
    if(!stroke)return;
    if(phase==="move"){
      const rect=event.currentTarget.getBoundingClientRect();
      const point={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
      const previous=stroke.points[stroke.points.length-1];
      if(Math.hypot(point.x-previous.x,point.y-previous.y)<0.002)return;
      stroke.points.push(point);
      setAnnotationLines(lines=>lines.map(item=>item.id===stroke.id?{...item,points:[...stroke.points]}:item));
      const now=performance.now();
      if(now-stroke.lastSentAt>=55){
        const points=stroke.points.slice(stroke.sent);
        stroke.sent=stroke.points.length;
        stroke.lastSentAt=now;
        sendRoomEvent({type:"annotation_stroke",stroke_id:stroke.id,points,color:stroke.color,done:false});
      }
      return;
    }
    const points=stroke.points.slice(stroke.sent);
    sendRoomEvent({type:"annotation_stroke",stroke_id:stroke.id,points,color:stroke.color,done:true});
    drawRef.current=null;
    removeAnnotationStroke(stroke.id,560);
    if(event.currentTarget.hasPointerCapture?.(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if(!call)return null;
  const incoming=call.status==="incoming",video=call.mediaType==="video",meeting=call.mode==="meeting";
  const connectedParticipants=[...peersRef.current.keys()].map(key=>remoteStreams[key]?.participant||joinedRef.current.get(key)||(call.participants||[]).find(item=>String(item.id)===String(key))).filter(item=>item&&Number(item.id)!==Number(user?.id));
  return <div className="voice-call-overlay" role="dialog" aria-modal="true"><section className={`voice-call-card ${video?"voice-call-card--video":""}`}><header className="call-room-head"><div><h2>{call.title}</h2><p><Volume2 size={16}/>{incoming?"Chamada recebida":call.status==="calling"?"Chamando participantes…":call.status==="waiting"?"Aguardando participantes…":call.status==="connecting"?"Conectando…":"Ao vivo"}</p></div>{meeting&&<span>Meeting</span>}</header>{video&&<div className={`call-video-stage ${annotating?"is-annotating":""}`} onPointerDown={event=>draw(event,"start")} onPointerMove={event=>draw(event,"move")} onPointerUp={event=>draw(event,"end")} onPointerCancel={event=>draw(event,"end")}><div className={`call-video-grid ${pinnedPeerId?"has-pinned":""}`}><div className="call-video-tile"><video ref={localVideoRef} autoPlay muted playsInline className={cameraOff&&!screenSharing?"is-off":""}/><span>Você {screenSharing?"· compartilhando tela":""}</span></div>{Object.entries(remoteStreams).filter(([id])=>!hiddenPeerIds.includes(id)).map(([id,item])=><RemoteMedia key={id} item={item} video pinned={pinnedPeerId===id} onPin={()=>setPinnedPeerId(current=>current===id?null:id)} onHide={()=>setHiddenPeerIds(current=>[...new Set([...current,id])])}/>)}</div>{hiddenPeerIds.length>0&&<div className="call-hidden-tiles"><small>Quadros ocultos:</small>{hiddenPeerIds.map(id=><button key={id} onClick={()=>setHiddenPeerIds(current=>current.filter(item=>item!==id))}>{personName(remoteStreams[id]?.participant)} · mostrar</button>)}</div>}<svg className="call-annotation-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none">{annotationLines.map(line=><polyline key={line.id} className={`call-annotation-stroke ${line.finishing?"is-finishing":""}`} points={(line.points||[]).map(point=>`${point.x*1000},${point.y*1000}`).join(" ")} stroke={line.color} strokeWidth="3.5"/>)}</svg></div>}{!video&&<div className="call-audio-grid"><div className="voice-call-card__pulse"><span>{call.mode==="direct"?personName(call.host)[0]:"G"}</span></div>{Object.entries(remoteStreams).map(([id,item])=><RemoteMedia key={id} item={item}/>)}</div>}<div className="call-reactions-live">{reactions.map((item,index)=><span key={item.id} style={{"--reaction-index":index}}><b>{item.emoji}</b><small>{item.name}</small></span>)}</div>{incoming?<div className="call-entry-actions"><button className="voice-call-button voice-call-button--decline" onClick={()=>finish("decline")} title="Recusar"><PhoneOff/></button>{video&&<button className="button" onClick={()=>accept(false)}><VideoOff size={17}/>Entrar sem câmera</button>}<button className="voice-call-button voice-call-button--accept" onClick={()=>accept(true)} title="Atender"><Phone/></button></div>:<><div className="voice-call-actions call-room-controls"><button className={`voice-call-button ${muted?"voice-call-button--muted":""}`} onClick={toggleMute} title={muted?"Ativar microfone":"Mutar áudio"}>{muted?<MicOff/>:<Mic/>}</button>{video&&<button className={`voice-call-button ${cameraOff?"voice-call-button--muted":""}`} onClick={toggleCamera} title={cameraOff?"Ativar câmera":"Desativar câmera"}>{cameraOff?<VideoOff/>:<Video/>}</button>}{video&&<button className={`voice-call-button ${screenSharing?"voice-call-button--active":""}`} onClick={toggleShare} title="Compartilhar tela"><MonitorUp/></button>}{video&&<button className={`voice-call-button ${annotating?"voice-call-button--active":""}`} onClick={()=>setAnnotating(value=>!value)} title="Fazer anotações"><Pencil/></button>}<button className="voice-call-button" onClick={()=>setPanel(panel==="reactions"?null:"reactions")} title="Reagir"><Smile/></button>{meeting&&<button className={`voice-call-button ${panel==="chat"?"voice-call-button--active":""}`} onClick={()=>setPanel(panel==="chat"?null:"chat")} title="Chat ao vivo"><MessageSquare/></button>}{meeting&&<button className={`voice-call-button ${panel==="poll"?"voice-call-button--active":""}`} onClick={()=>setPanel(panel==="poll"?null:"poll")} title="Enquete"><BarChart3/></button>}<button className="voice-call-button voice-call-button--decline" onClick={leaveCall} title={meeting&&call.isHost?"Sair ou encerrar reunião":meeting?"Sair da reunião":"Encerrar"}><PhoneOff/></button></div>{panel==="reactions"&&<div className="call-reaction-picker">{reactionOptions.map(emoji=><button key={emoji} onClick={()=>react(emoji)}>{emoji}</button>)}</div>}{meeting&&panel==="chat"&&<RoomChat messages={roomMessages} value={chatText} onChange={setChatText} onSend={sendChat}/>} {meeting&&panel==="poll"&&<PollPanel poll={poll} draft={pollDraft} setDraft={setPollDraft} onPublish={publishPoll} onVote={vote} onClose={closePoll} canClose={call.isHost} now={pollNow} userId={user?.id}/>}</>}{hostExitOpen&&<div className="meeting-host-exit"><div><strong>Você é o anfitrião</strong><p>Transfira a sala antes de sair ou encerre a chamada para todos.</p></div>{connectedParticipants.length>0?<div className="meeting-host-exit__people">{connectedParticipants.map(participant=><button type="button" key={participant.id} onClick={()=>transferHost(participant)}><span>{personName(participant)[0]}</span><div><strong>{personName(participant)}</strong><small>Transferir e sair</small></div></button>)}</div>:<p className="meeting-host-exit__empty">Nenhum outro participante está conectado para receber a sala.</p>}<div className="meeting-host-exit__actions"><button type="button" className="button" onClick={()=>setHostExitOpen(false)}>Continuar na reunião</button><button type="button" className="button-danger" onClick={()=>finish("end")}><PhoneOff size={16}/>Encerrar para todos</button></div></div>}<small>Áudio, vídeo e colaboração ao vivo — não são gravados.</small></section></div>;
}

function RemoteMedia({item,video=false,pinned=false,onPin,onHide}){const ref=useRef(null);useEffect(()=>{if(ref.current)ref.current.srcObject=item.stream},[item.stream]);return video?<div className={`call-video-tile ${pinned?"is-pinned":""}`}><video ref={ref} autoPlay playsInline/><span>{personName(item.participant)}</span><div className="call-video-tile__actions"><button onClick={onPin} title={pinned?"Desafixar quadro":"Fixar quadro"}><Pin size={14}/></button><button onClick={onHide} title="Ocultar quadro"><EyeOff size={14}/></button></div></div>:<div className="call-audio-person"><audio ref={ref} autoPlay/><span>{personName(item.participant)}</span></div>}
function RoomChat({messages,value,onChange,onSend}){return <aside className="call-collaboration-panel"><header><MessageSquare size={16}/><strong>Chat ao vivo</strong></header><div className="call-room-messages">{messages.length?messages.map(message=><p key={message.id}><strong>{personName(message.sender)}</strong><span>{message.text}</span></p>):<small>Nenhuma mensagem ainda.</small>}</div><form onSubmit={onSend}><input className="input" value={value} onChange={event=>onChange(event.target.value)} placeholder="Mensagem para a reunião"/><button className="icon-button"><Send size={16}/></button></form></aside>}
function PollPanel({ poll, draft, setDraft, onPublish, onVote, onClose, canClose, now, userId }) {
  if (poll) {
    const total = poll.options.reduce((sum, option) => sum + option.voters.length, 0);
    const voted = poll.options.some((option) => option.voters.includes(userId));
    const remaining = Math.max(0, Math.ceil((new Date(poll.closes_at).getTime() - now) / 1000));
    const expired = poll.closed || remaining <= 0;
    return (
      <aside className="call-collaboration-panel call-poll">
        <header><BarChart3 size={16} /><strong>{poll.question}</strong><span className={expired?"is-ended":""}>{expired?"Encerrada":`${remaining}s`}</span></header>
        {poll.options.map((option) => {
          const percent = total ? Math.round((option.voters.length / total) * 100) : 0;
          return (
            <button key={option.id} disabled={voted||expired} onClick={() => onVote(option.id)}>
              <span>{option.label}</span><b>{percent}%</b><i style={{ width: `${percent}%` }} />
            </button>
          );
        })}
        <div className="call-poll__footer"><small>{total} voto(s)</small>{canClose&&!expired&&<button className="button" type="button" onClick={onClose}>Encerrar agora</button>}</div>
      </aside>
    );
  }
  return (
    <form className="call-collaboration-panel call-poll-form" onSubmit={onPublish}>
      <header><BarChart3 size={16} /><strong>Nova enquete</strong></header>
      <input className="input" value={draft.question} onChange={(event) => setDraft({ ...draft, question: event.target.value })} placeholder="Pergunta" />
      {draft.options.map((option, index) => (
        <input className="input" key={index} value={option} onChange={(event) => setDraft({ ...draft, options: draft.options.map((item, current) => current === index ? event.target.value : item) })} placeholder={`Opção ${index + 1}`} />
      ))}
      <label>Duração<select className="select" value={draft.duration_seconds} onChange={(event)=>setDraft({...draft,duration_seconds:Number(event.target.value)})}><option value={30}>30 segundos</option><option value={60}>1 minuto</option><option value={120}>2 minutos</option><option value={300}>5 minutos</option></select></label>
      <div>
        <button type="button" className="button" onClick={() => setDraft({ ...draft, options: [...draft.options, ""] })}>+ Opção</button>
        <button className="button button--primary"><Check size={15} />Publicar</button>
      </div>
    </form>
  );
}