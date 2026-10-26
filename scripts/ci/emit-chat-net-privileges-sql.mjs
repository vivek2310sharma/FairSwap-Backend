// Fixed local fixture stream for the isolated PG15 container. No connection parameters.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {canonicalDispatchFunctions} from '../../tests/chat-v2/privilege-fixture.mjs';
if(process.argv.length!==2)throw Error('No database target arguments accepted');
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>readFileSync(resolve(root,p),'utf8');
process.stdout.write([
  read('tests/chat-v2/bootstrap.sql'),
  read('supabase/migrations/20260914000011_create_communication.sql').replace(/ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;/,''),
  read('supabase/forward-migrations/chat-v2/supabase/migrations/20261025204922_chat_v2_inbox_and_safety.sql'),
  read('supabase/forward-migrations/chat-v2/supabase/migrations/20261026073143_chat_safety_worker_infrastructure.sql'),
  read('tests/chat-v2/legacy-dispatch-tables.sql'),
  canonicalDispatchFunctions(root),
  read('tests/chat-v2/net-privileges.test.sql'),
].join('\n'));
