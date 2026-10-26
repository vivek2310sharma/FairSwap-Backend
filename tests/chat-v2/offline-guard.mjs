import {Socket} from 'node:net';
let attempts=0;
const deny=()=>{attempts++;throw new Error('CHAT_V2_NETWORK_FORBIDDEN');};
globalThis.fetch=deny;
Socket.prototype.connect=deny;
process.on('exit',()=>{if(attempts)process.exitCode=1;});
