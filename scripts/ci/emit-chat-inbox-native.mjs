import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {canonicalMessaging,root} from '../../tests/chat-v2-inbox-only/canonical.mjs';
import {candidate} from '../release/chat-v2-inbox-only.mjs';
if(process.argv.length!==2)throw Error('No database targets accepted');
process.stdout.write(readFileSync(resolve(root,'tests/chat-v2-inbox-only/bootstrap.sql'),'utf8')+'\n'+canonicalMessaging()+'\n'+candidate().sql+'\n'+readFileSync(resolve(root,'tests/chat-v2-inbox-only/native-security.sql'),'utf8'));
