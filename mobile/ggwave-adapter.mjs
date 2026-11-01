// ggWave interoperable third-party codec. Source: https://github.com/themonnie/ggwave-js (MIT).
import * as gw from './vendor/ggwave-js.min.js';
export const GGWAVE_PROFILE = Object.freeze({
  ggwave: {label:'ggwave Audible Fast (interop)',protocol:1},
  ggwave_safe: {label:'ggwave Audible Normal',protocol:0},
  ggwave_ultra: {label:'ggwave Ultrasound (eksperyment)',protocol:3}
});
function create(rate){
  const params=gw.getDefaultParameters();
  params.sampleRateInp=rate;params.sampleRateOut=rate;params.sampleRate=rate;
  return gw.init(params);
}
export function encodeGgwave(payload, profile='ggwave',rate=48000){
  const meta=GGWAVE_PROFILE[profile];if(!meta)throw Error('Nieznany profil ggwave.');
  const text=typeof payload==='string'?payload:new TextDecoder().decode(payload);
  if(new TextEncoder().encode(text).length>128)throw Error('ggwave: tekst nie może przekraczać 128 bajtów.');
  const instance=create(rate);
  try{
    const waveform=gw.encode(instance,text,meta.protocol,40);
    if(!waveform?.byteLength||waveform.byteLength%4)throw Error('ggwave nie zwrócił sygnału PCM.');
    const view=new Float32Array(waveform.buffer,waveform.byteOffset,waveform.byteLength/4);
    return Float32Array.from(view);
  }finally{gw.free(instance);}
}
export function decodeGgwave(samples,rate=48000){
  const instance=create(rate);
  try{
    // Use the same input format as original ggwave: packed Float32 PCM chunks.
    const chunkSize=1024;
    for(let offset=0;offset<samples.length;offset+=chunkSize){
      const part=new Float32Array(chunkSize);
      part.set(samples.subarray(offset,Math.min(samples.length,offset+chunkSize)));
      const decoded=gw.decode(instance,new Uint8Array(part.buffer));
      if(decoded?.length) return {data:new Uint8Array(decoded),type:1,corrected:0,fec:true,profile:'ggwave'};
    }
    throw Error('ggwave: nie wykryto poprawnej wiadomości.');
  }finally{gw.free(instance);}
}
