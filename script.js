let peer, myId, roomId, isHost = false, username;
let connections = {};
let participants = {};
let localStreams = {};
let mediaCalls = {};

function enterApp() {
  username = document.getElementById("username").value.trim();
  if (!username) return alert("Enter your name");
  peer = new Peer(undefined,{
    config: {
      "iceServers": [{
        "urls": "turn:turn01.hubl.in?transport=udp"
      }]
    }
  });
  peer.on("open", id => {
    myId = id;
    const params = new URLSearchParams(window.location.search);
    const url_id = params.get("id");
    if (url_id) {
      roomId = url_id;
      document.getElementById("setup").style.display = "none";
      document.getElementById("main-ui").style.display = "none";
      document.getElementById("room-ui").style.display = "block";
      document.getElementById("room-id").innerText = roomId;
      let conn = peer.connect(roomId);
      setupDataConnection(conn, true);
    } else {
      document.getElementById("setup").style.display = "none";
      document.getElementById("main-ui").style.display = "block";
    }
    participants[myId] = {
      username: username,
      permissions: { video: false, audio: false, screen: false }
    };
  });

  peer.on("connection", conn => {
    setupDataConnection(conn);
  });

  peer.on("call", call => {
    call.answer();
    call.on("stream",stream => {
      if (call.peer!=myId) {
        addMediaStream(call.peer,call.metadata.mediaType,stream,call.metadata.username);
      }
    });
  });
}

function createRoom() {
  isHost = true;
  roomId = myId;
  document.getElementById("main-ui").style.display = "none";
  document.getElementById("room-ui").style.display = "block";
  document.getElementById("room-id").innerText = roomId;
  participants[myId].permissions = { video: true, audio: true, screen: true };
  updateParticipantsUI();
}

function joinRoom() {
  roomId = prompt("Enter Room ID");
  if (!roomId) return;
  document.getElementById("main-ui").style.display = "none";
  document.getElementById("room-ui").style.display = "block";
  document.getElementById("room-id").innerText = roomId;
  let conn = peer.connect(roomId);
  setupDataConnection(conn, true);
}

function setupDataConnection(conn, isJoining = false) {
  connections[conn.peer] = conn;
  conn.on("open", () => {
    if (isJoining) {
      conn.send({ type: "join", id: myId, username: username });
    }
    sendActiveMediaTo(conn.peer);
  });
  conn.on("data", data => {
    handleDataMessage(data, conn);
  });
  conn.on("close", () => {
    removeParticipant(conn.peer);
  });
}

function handleDataMessage(data, conn) {
  switch(data.type) {
    case "join":
      participants[data.id] = {
        username: data.username,
        permissions: { video: false, audio: false, screen: false }
      };
      updateParticipantsUI();
      broadcast({ type:"update-participants",participants });
      establishMissingConnections();
      sendActiveMediaTo(conn.peer);
      break;
    case "update-participants":
      participants = data.participants;
      updateParticipantsUI();
      establishMissingConnections();
      break;
    case "chat":
      appendChatMessage(data.username, data.message);
      break;
    case "permissions":
      if (data.id==myId&&!data.permissions[data.mediaType]) {
        stopLocalMedia(data.mediaType);
        document.getElementById("btn-" + data.mediaType).innerText =
          (data.mediaType=="screen"?"Share Screen":"Start "+capitalize(data.mediaType));
      }
      if (participants[data.id]) {
        participants[data.id].permissions[data.mediaType] = data.permissions[data.mediaType];
        if (!data.permissions[data.mediaType]) {
          if (mediaCalls[data.id+"-"+data.mediaType]) {
            mediaCalls[data.id+"-"+data.mediaType].close();
            delete mediaCalls[data.id+"-"+data.mediaType];
            removeMediaStream(data.id,data.mediaType);
          }
        }
        updateParticipantsUI();
      }
      break;
    case "media-start":
      break;
    case "media-stop":
      removeMediaStream(data.id,data.mediaType);
      break;
  }
}

function broadcast(data, excludePeer = null) {
  for (let pid in connections) {
    if (pid==excludePeer) continue;
    connections[pid].send(data);
  }
}

function establishMissingConnections() {
  for (let pid in participants) {
    if (pid==myId) continue;
    if (!connections[pid]) {
      let conn = peer.connect(pid);
      setupDataConnection(conn);
    }
  }
}

function sendMessage() {
  let msg = document.getElementById("chat-input").value.trim();
  if (!msg) return;
  appendChatMessage(username, msg);
  broadcast({ type: "chat", username, message: msg });
  document.getElementById("chat-input").value = "";
}

function appendChatMessage(sender, message) {
  let chatBox = document.getElementById("chat-box");
  chatBox.value += sender + ": " + message + "\n";
  chatBox.scrollTop = chatBox.scrollHeight;
}

function updateParticipantsUI() {
  let list = document.getElementById("participants");
  list.innerHTML = "";
  for (let pid in participants) {
    let li = document.createElement("li");
    li.innerText = participants[pid].username + " (" + pid + ")";
    if (isHost&&pid!=myId) {
      ["video","audio","screen"].forEach(type => {
        let btn = document.createElement("button");
        btn.innerText = participants[pid].permissions[type]?"Revoke "+type:"Allow "+type;
        btn.onclick = () => {
          participants[pid].permissions[type] = !participants[pid].permissions[type];
          broadcast({type:"permissions",id:pid,mediaType:type,permissions:participants[pid].permissions});
          updateParticipantsUI();
        };
        li.appendChild(btn);
      });
    }
    list.appendChild(li);
  }
}

function removeParticipant(pid) {
  delete participants[pid];
  updateParticipantsUI();
  ["video","audio","screen"].forEach(type => removeMediaStream(pid, type));
}

function toggleMedia(type) {
  if (localStreams[type]) {
    stopLocalMedia(type);
    document.getElementById("btn-"+type).innerText = (type=="screen"?"Share Screen":"Start "+capitalize(type));
  } else {
    if (!participants[myId].permissions[type]) {
      return alert("Permission denied by host for "+type);
    }
    startMedia(type);
  }
}

function startMedia(type) {
  let constraints;
  if (type=="screen") {
    constraints = { video: true, audio: true };
  } else if (type=="video") {
    constraints = { video: true, audio: false };
  } else {
    constraints = { audio: true, video: false };
  }
  let getMedia = type=="screen"?
    navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices) :
    navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  getMedia(constraints)
    .then(stream => {
      if (localStreams[type]) stopLocalMedia(type);
      localStreams[type] = stream;
      stream.getTracks().forEach(track => {
        track.onended = () => {
          stopLocalMedia(type);
          document.getElementById("btn-"+type).innerText =
            (type=="screen"?"Share Screen":"Start "+capitalize(type));
        };
      });
      document.getElementById("btn-"+type).innerText = (type=="screen"?"Stop Sharing":"Stop "+capitalize(type));
      broadcast({ type: "media-start",id: myId,mediaType: type,username });
      for (let pid in participants) {
        if (pid==myId) continue;
        let call = peer.call(pid,stream, { metadata: { mediaType: type,username } });
        mediaCalls[pid+ "-" + type] = call;
        call.on("close",() => { removeMediaStream(pid,type); });
      }
      if (type=="video") {
        addOwnMediaStream(type,stream);
      }
    })
    .catch(err => {
      console.error("Error accessing " + type, err);
      alert("Error accessing " + type + ": " + err.message);
    });
}

function sendActiveMediaTo(peerId) {
  for (let type in localStreams) {
    let stream = localStreams[type];
    let call = peer.call(peerId, stream, { metadata: { mediaType: type, username } });
    mediaCalls[peerId + "-" + type] = call;
    call.on("close", () => { removeMediaStream(peerId, type); });
  }
}

function stopLocalMedia(type) {
  if (localStreams[type]) {
    localStreams[type].getTracks().forEach(track => track.stop());
    delete localStreams[type];
    for (let key in mediaCalls) {
      if (key.endsWith("-" + type)) {
        try {
          mediaCalls[key].close();
        } catch(e){}
        delete mediaCalls[key];
      }
    }
    if (type=="video") {
      let ownPreview = document.getElementById("own-"+type);
      if (ownPreview) ownPreview.remove();
    }
    broadcast({ type: "media-stop", id: myId, mediaType: type });
  }
}

function addMediaStream(peerId, mediaType, stream, senderName) {
  if (document.getElementById(peerId+"-"+mediaType)) return;
  if (peerId==myId&&(mediaType=="audio"||mediaType=="screen")) return;
  let container = document.createElement("div");
  container.className = "media-container";
  container.id = peerId + "-" + mediaType;
  let label = document.createElement("p");
  label.innerText = senderName+" ("+peerId+") - "+mediaType;
  container.appendChild(label);
  if (mediaType=="video"||mediaType=="screen") {
    let vid = document.createElement("video");
    vid.srcObject = stream;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.controls = true;
    container.appendChild(vid);
  } else if (mediaType=="audio") {
    let aud = document.createElement("audio");
    aud.srcObject = stream;
    aud.autoplay = true;
    container.appendChild(aud);
  }
  document.getElementById("media-list").appendChild(container);
}

function addOwnMediaStream(type,stream) {
  let existing = document.getElementById("own-"+type);
  if (existing) existing.remove();
  let container = document.createElement("div");
  container.className = "media-container";
  container.id = "own-" + type;
  let label = document.createElement("p");
  label.innerText = "You ("+myId+") - "+type;
  container.appendChild(label);
  let vid = document.createElement("video");
  vid.srcObject = stream;
  vid.autoplay = true;
  vid.muted = true;
  vid.playsInline = true;
  container.appendChild(vid);
  document.getElementById("media-list").appendChild(container);
}

function removeMediaStream(peerId, mediaType) {
  let el = document.getElementById(peerId + "-" + mediaType);
  if (el) el.remove();
}

function capitalize(str) {
  return str.charAt(0).toUpperCase()+str.slice(1);
}

window.addEventListener("beforeunload", function() {
  for (let pid in connections) {
    connections[pid].close();
  }
  for (let type in localStreams) {
    stopLocalMedia(type);
  }
  if (peer && !peer.destroyed) {
    peer.destroy();
  }
});
