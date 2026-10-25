import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesCheckout } from './verify-canonical-checkout.mjs';
test('accepts identical bytes and exact LF-to-CRLF checkout conversion',()=>{
 const canonical=Buffer.from('begin;\nselect 1;\ncommit;\n');
 assert.equal(matchesCheckout(canonical,canonical),true);
 assert.equal(matchesCheckout(canonical,Buffer.from('begin;\r\nselect 1;\r\ncommit;\r\n')),true);
});
test('rejects changed SQL, added whitespace, mixed line endings and BOMs',()=>{
 const canonical=Buffer.from('select 1;\ncommit;\n');
 for(const text of ['select 2;\r\ncommit;\r\n','select 1; \r\ncommit;\r\n','select 1;\r\ncommit;\n','\ufeffselect 1;\r\ncommit;\r\n'])assert.equal(matchesCheckout(canonical,Buffer.from(text)),false);
});
