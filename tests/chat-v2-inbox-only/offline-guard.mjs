import {Socket} from 'node:net';
let attempts=0;
const deny=()=>{attempts++;throw Error('CHAT_INBOX_RELEASE_NETWORK_FORBIDDEN');};
globalThis.fetch=deny;Socket.prototype.connect=deny;
process.on('exit',()=>{if(attempts)process.exitCode=1;});
