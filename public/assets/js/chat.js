const socket = io();
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatName = document.getElementById('chatName');
const chatSend = document.getElementById('chatSend');

// Prompt user for name
chatSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', e => { if(e.key==='Enter') sendMessage(); });

function sendMessage() {
  const name = chatName.value.trim() || 'Anonymous';
  const message = chatInput.value.trim();
  if (!message) return;
  
  socket.emit('join chat', { name }); // join if not joined yet
  socket.emit('chat message', { message }); // send message
  chatInput.value = '';
}

// Append message to chat box
function appendMessage(msgObj) {
  const div = document.createElement('div');
  div.textContent = msgObj.text;
  div.style.marginBottom = '5px';
  div.style.padding = '4px 6px';
  div.style.borderRadius = '5px';
  div.style.backgroundColor = msgObj.isAdmin ? '#cce5ff' : '#e0e0e0';
  div.style.color = msgObj.isAdmin ? '#004085' : '#333';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Play sound if message from admin
  if(msgObj.isAdmin) {
    const audio = new Audio('/public/assets/sounds/notification.mp3');
    audio.play().catch(() => {});
  }
}

// Receive messages
socket.on('chat message', msgObj => appendMessage(msgObj));

// Load chat history on connection
socket.on('chat history', arr => arr.forEach(msgObj => appendMessage(msgObj)));
