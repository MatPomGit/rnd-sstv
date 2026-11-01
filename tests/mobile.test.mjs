import test from 'node:test';
import assert from 'node:assert/strict';
import {MODES,PROFILES,crc32,fecEncode,fecDecode,makeFrame,parseFrameBits,
        encodeDigital,decodeDigital,encodeSstv,toWav,fromWav} from '../mobile/codec.mjs';

test('CRC32 standard vector',()=>assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926));
test('Hamming single-bit errors corrected',()=>{
 const expected=Uint8Array.from([0,1,127,128,255]);
 const coded=fecEncode(expected);
 for(let i=0;i<coded.length;i+=7)coded[i]^=1;
 const got=fecDecode(coded);
 assert.deepEqual(got.bytes,expected);
 assert.equal(got.fixed,expected.length*2);
});
test('CRC rejects tampering despite FEC valid payload',()=>{
 const pkt=makeFrame(Uint8Array.from([1,2,3]),1,false);
 const bits=pkt.bits.slice();bits[13*14+3]^=1;
 assert.throws(()=>parseFrameBits(bits),/CRC/);
});
test('digital frame roundtrips across modem profiles including leading silence',()=>{
 for(const name of Object.keys(PROFILES)){
  const text=new TextEncoder().encode('TEST: '+name+' 123');
  const wave=encodeDigital(text,1,name,true,48000);
  const padded=new Float32Array(wave.length+4800);
  padded.set(wave,4800);
  let got; try {got=decodeDigital(padded,48000,name);}catch(e){throw Error(name+': '+e.message);}
  assert.equal(got.type,1,name);
  assert.deepEqual(got.data,text,name);
 }
});
test('raw digital frame roundtrip no FEC',()=>{
 const data=Uint8Array.from([0,1,22,255,18,22]);
 const got=decodeDigital(encodeDigital(data,3,'ofdm',false,48000),48000,'ofdm');
 assert.deepEqual(got.data,data);
 assert.equal(got.fec,false);
});
test('all Robot SSTV modes generate duration and WAV file',async()=>{
 for(const [key,m] of Object.entries(MODES)){
  const rgba=new Uint8ClampedArray(m.width*m.height*4);
  for(let i=0;i<m.width*m.height;i++){rgba[i*4]=250;rgba[i*4+1]=100;rgba[i*4+2]=50;rgba[i*4+3]=255;}
  const audio=encodeSstv(rgba,m.width,m.height,key,48000);
  const lines=m.sync+m.porch+m.y+(m.pattern==='full'?2:m.pattern==='pair'?1:0)*(m.sep+m.cporch+m.chroma);
  assert.ok(Math.abs(audio.length/48000-(.910+lines*m.height/1000))<.015,key);
  const wav=await fromWav(toWav(audio));
  assert.equal(wav.rate,48000);
  assert.equal(wav.samples.length,audio.length);
 }
});
