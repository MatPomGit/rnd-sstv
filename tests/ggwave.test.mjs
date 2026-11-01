import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeGgwave,decodeGgwave} from '../mobile/ggwave-adapter.mjs';

test('ggwave audible protocol roundtrip with original framing and RS',()=>{
  const message='Interoperacyjna wiadomosc testowa';
  const signal=encodeGgwave(message,'ggwave',48000);
  assert.ok(signal.length>48000);
  const recovered=decodeGgwave(signal,48000);
  assert.equal(new TextDecoder().decode(recovered.data),message);
});
