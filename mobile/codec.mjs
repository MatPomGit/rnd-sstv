// Acoustic modem core. Pure JavaScript: browser and Node.js, no external dependencies.
export const RATE = 48000;
export const MAX_PAYLOAD = 4096;
const PI2 = Math.PI * 2;
const MAGIC = [0x52, 0x44, 0x53, 0x31]; // RDS1
export const MODES = Object.freeze({
  robot12: { label: "Robot Color 12", width: 160, height: 120, vis: 0, sync: 7, porch: 0, y: 60, sep: 3, cporch: 0, chroma: 30, pattern: "pair" },
  robot24: { label: "Robot Color 24", width: 320, height: 120, vis: 4, sync: 9, porch: 3, y: 88, sep: 4.5, cporch: 1.5, chroma: 44, pattern: "full" },
  robot36: { label: "Robot Color 36", width: 320, height: 240, vis: 8, sync: 9, porch: 3, y: 88, sep: 4.5, cporch: 1.5, chroma: 44, pattern: "pair" },
  bw8: { label: "Robot B/W 8", width: 160, height: 120, vis: 2, sync: 10, porch: 0, y: 56, sep: 0, cporch: 0, chroma: 0, pattern: "mono" }
});
export const PROFILES = Object.freeze({
  fsk: { label: "AFSK 1200/2200 Hz", kind: "fsk", ms: 12, bits: 1, frequencies: [1200, 2200] },
  mfsk: { label: "MFSK-4 (1–2,8 kHz)", kind: "mfsk", ms: 20, bits: 2, frequencies: [1000, 1600, 2200, 2800] },
  ofdm: { label: "OFDM / DBPSK-12", kind: "ofdm", ms: 20, bits: 12, frequencies: [900,1200,1500,1800,2100,2400,2700,3000,3300,3600,3900,4200] },
  chirp: { label: "CSS chirp (eksperymentalny)", kind: "chirp", ms: 35, bits: 1, frequencies: [] },
  ultra: { label: "MFSK 17–18,5 kHz (eksperyment)", kind: "mfsk", ms: 25, bits: 2, frequencies: [17000,17500,18000,18500] }
});

function requireRate(rate) {
  if (!Number.isInteger(rate) || rate < 32000 || rate > 192000) throw new Error("Nieobsługiwana częstotliwość próbkowania.");
}
function bytes(data) { return data instanceof Uint8Array ? data : new Uint8Array(data); }

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const b of bytes(buffer)) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function int32put(b, offset, value) {
  b[offset] = (value >>> 24) & 255;
  b[offset+1] = (value >>> 16) & 255;
  b[offset+2] = (value >>> 8) & 255;
  b[offset+3] = value & 255;
}
function int32get(b, off) { return ((b[off] * 16777216) + (b[off+1] << 16) + (b[off+2] << 8) + b[off+3]) >>> 0; }
function bitsFromBytes(buffer) {
  const out = [];
  for (const b of buffer) for (let i = 7; i >= 0; i--) out.push((b >>> i) & 1);
  return out;
}
function bytesFromBits(bits, count) {
  const result = new Uint8Array(count);
  for (let i = 0; i < count*8; i++) result[i >>> 3] = (result[i >>> 3] << 1) | bits[i];
  return result;
}
// Hamming(7,4), Hamming distance 3: correct a single bit per nibble.
function nibbleToHamming(n) {
  const a = (n >>> 3) & 1, b = (n >>> 2) & 1, c = (n >>> 1) & 1, d = n & 1;
  return [a^b^d, a^c^d, a, b^c^d, b, c, d];
}
function hammingToNibble(seven) {
  const v = seven.slice();
  const syndrome = (v[0]^v[2]^v[4]^v[6]) +
    2*(v[1]^v[2]^v[5]^v[6]) + 4*(v[3]^v[4]^v[5]^v[6]);
  if (syndrome) v[syndrome-1] ^= 1;
  return { value: (v[2]<<3)|(v[4]<<2)|(v[5]<<1)|v[6], fixed: syndrome !== 0 };
}
export function fecEncode(buffer) {
  const out = [];
  for (const b of bytes(buffer)) out.push(...nibbleToHamming(b>>>4), ...nibbleToHamming(b&15));
  return out;
}
export function fecDecode(bits) {
  if (bits.length % 14) throw new Error("Niekompletna ramka FEC.");
  const result = new Uint8Array(bits.length/14);
  let fixed = 0;
  for (let i=0; i<result.length; i++) {
    const upper=hammingToNibble(bits.slice(14*i, 14*i+7));
    const lower=hammingToNibble(bits.slice(14*i+7, 14*i+14));
    result[i]=(upper.value<<4)|lower.value;
    fixed+=Number(upper.fixed)+Number(lower.fixed);
  }
  return { bytes: result, fixed };
}
export function makeFrame(payload, type = 1, useFec = true) {
  const data = bytes(payload);
  if (data.length > MAX_PAYLOAD) throw new Error("Plik przekracza 4096 B. Zmniejsz rozmiar obrazu lub pliku.");
  if (![1,2,3].includes(type)) throw new Error("Nieznany typ danych.");
  return frameHeader(data, type, useFec);
}
function frameHeader(data, type, useFec) {
  // Header: 4B magic + 1B version + 1B type + 1B flags + 2B length + 4B CRC = 13B.
  const header = new Uint8Array(13);
  header.set(MAGIC);
  header[4] = 1; header[5] = type; header[6] = useFec ? 1 : 0;
  header[7] = (data.length>>>8)&255; header[8] = data.length&255;
  int32put(header, 9, crc32(data));
  return { header, bits: [...fecEncode(header), ...(useFec ? fecEncode(data) : bitsFromBytes(data))] };
}
function readHeader(bits) {
  const decoded = fecDecode(bits.slice(0, 13*14));
  const b = decoded.bytes;
  for (let i=0; i<4; i++) if (b[i] !== MAGIC[i]) throw new Error("Nie znaleziono ramki RDS1.");
  if (b[4] !== 1 || ![1,2,3].includes(b[5]) || (b[6]&~1)) throw new Error("Nieobsługiwana ramka.");
  const length = (b[7]<<8)|b[8];
  if (length>MAX_PAYLOAD) throw new Error("Niedozwolony rozmiar ramki.");
  return { type:b[5], fec:!!b[6], length, crc:int32get(b,9), fixed:decoded.fixed };
}
export function parseFrameBits(bits) {
  const headerBits = 13*14;
  if (bits.length<headerBits) throw new Error("Za krótka ramka.");
  const header = readHeader(bits);
  const payloadBits = header.length*(header.fec?14:8);
  if (bits.length<headerBits+payloadBits) throw new Error("Niepełna transmisja.");
  const chunk = bits.slice(headerBits, headerBits+payloadBits);
  const parsed = header.fec ? fecDecode(chunk) : { bytes:bytesFromBits(chunk,header.length), fixed:0 };
  if (crc32(parsed.bytes)!==header.crc) throw new Error("Błąd CRC32. Spróbuj ponownie lub wybierz stabilniejszy tryb.");
  return { data:parsed.bytes, type:header.type, fec:header.fec,
           corrected:header.fixed+parsed.fixed, consumedBits:headerBits+payloadBits };
}
class Synth {
  constructor(rate) { this.rate=rate; this.phase=0; this.parts=[]; this.size=0; }
  push(part) { this.parts.push(part); this.size+=part.length; }
  tone(hz,ms) {
    if (!ms) return;
    const n=Math.round(this.rate*ms/1000), b=new Float32Array(n), step=PI2*hz/this.rate;
    for (let i=0;i<n;i++) b[i]=0.72*Math.sin(this.phase+i*step);
    this.phase=(this.phase+n*step)%PI2;
    this.push(b);
  }
  scan(values, ms) {
    const n=Math.round(this.rate*ms/1000), b=new Float32Array(n);
    let phase=this.phase;
    for (let i=0;i<n;i++) {
      const pixel=values[Math.min(values.length-1,Math.floor(i*values.length/n))];
      b[i]=0.72*Math.sin(phase);
      phase+=PI2*(1500+800*pixel/255)/this.rate;
    }
    this.phase=phase%PI2;
    this.push(b);
  }
  chirp(up, ms, amplitude=0.72) {
    const n=Math.round(this.rate*ms/1000), b=new Float32Array(n);
    let phase=this.phase;
    for(let i=0;i<n;i++) {
      const hz=up?1200+1600*i/n:2800-1600*i/n;
      b[i]=amplitude*Math.sin(phase);
      phase+=PI2*hz/this.rate;
    }
    this.phase=phase%PI2; this.push(b);
  }
  ofdm(signs, ms, carriers) {
    const n=Math.round(this.rate*ms/1000), b=new Float32Array(n);
    for(let i=0;i<n;i++) {
      let value=0;
      for(let c=0;c<carriers.length;c++) value+=signs[c]*Math.cos(PI2*carriers[c]*i/this.rate);
      b[i]=0.66*value/carriers.length;
    }
    this.push(b);
  }
  result() {
    const out=new Float32Array(this.size);
    let offset=0; for(const p of this.parts){out.set(p,offset);offset+=p.length;}
    return out;
  }
}
function projection(samples,start,n,hz,rate,chirp=null) {
  if (start<0 || start+n>samples.length || n<2) return [0,0];
  let real=0,imag=0;
  for(let i=0;i<n;i++) {
    const phase=chirp===null?PI2*hz*i/rate:
      PI2*((chirp?1200:2800)*i/rate+(chirp?800:-800)*(i/rate)*(i/rate)/(n/rate));
    real+=samples[start+i]*Math.cos(phase);
    imag+=samples[start+i]*Math.sin(phase);
  }
  return [real,imag];
}
function power(samples,start,n,hz,rate) {
  const a=projection(samples,start,n,hz,rate);
  let e=0; for(let i=start;i<start+n && i<samples.length;i++)e+=samples[i]*samples[i];
  return e>1e-5 ? 2*(a[0]*a[0]+a[1]*a[1])/(n*e):0;
}
function symbolBits(samples, start, profile, rate, previous=null) {
  const n=Math.round(rate*profile.ms/1000), step=Math.round(n*.12), inner=n-2*step;
  if (start+n>samples.length) throw new Error("Koniec nagrania przed końcem transmisji.");
  if(profile.kind==='fsk'||profile.kind==='mfsk') {
    const idx=profile.frequencies.map(hz=>power(samples,start+step,inner,hz,rate));
    const chosen=idx.indexOf(Math.max(...idx));
    const bits=[];for(let b=profile.bits-1;b>=0;b--)bits.push((chosen>>b)&1);
    return {bits, previous};
  }
  if(profile.kind==='chirp') {
    const up=projection(samples,start,n,0,rate,true);
    const down=projection(samples,start,n,0,rate,false);
    const p1=up[0]**2+up[1]**2, p0=down[0]**2+down[1]**2;
    return {bits:[p1>p0?1:0],previous};
  }
  const complex=profile.frequencies.map(hz=>projection(samples,start,n,hz,rate));
  if(!previous) return {bits:[],previous:complex};
  const bits=complex.map((c,i)=>((c[0]*previous[i][0]+c[1]*previous[i][1])<0?1:0));
  return {bits,previous:complex};
}
function waveformBits(bits, profile, rate) {
  const synth=new Synth(rate);
  // Identifiable in an ambient recording, not an acoustic-ultrasonic handshake.
  synth.tone(1900,300);
  synth.tone(1200,100);
  const padded=bits.slice();
  while(padded.length%profile.bits)padded.push(0);
  if(profile.kind==='ofdm') {
    const signs=profile.frequencies.map(()=>1);
    synth.ofdm(signs,profile.ms,profile.frequencies); // reference symbol for DBPSK
    for(let pos=0;pos<padded.length;pos+=profile.bits) {
      for(let i=0;i<profile.bits;i++)if(padded[pos+i])signs[i]*=-1;
      synth.ofdm(signs,profile.ms,profile.frequencies);
    }
  } else for(let pos=0;pos<padded.length;pos+=profile.bits) {
    let value=0;for(let i=0;i<profile.bits;i++)value=value*2+padded[pos+i];
    if(profile.kind==='chirp')synth.chirp(Boolean(value),profile.ms);
    else synth.tone(profile.frequencies[value],profile.ms);
  }
  synth.tone(1900,70);
  return synth.result();
}
export function estimateDuration(payloadLength, profileName, useFec=true) {
  const p=PROFILES[profileName]; if(!p)throw new Error("Nieznany profil.");
  const bits=13*14+payloadLength*(useFec?14:8);
  return .47+(Math.ceil(bits/p.bits)+(p.kind==='ofdm'?1:0))*p.ms/1000;
}
export function encodeDigital(payload,type=1,profileName='ofdm',useFec=true,rate=RATE) {
  requireRate(rate);
  const profile=PROFILES[profileName];
  if(!profile) throw new Error("Nieznany profil.");
  return waveformBits(makeFrame(bytes(payload),type,useFec).bits,profile,rate);
}
function meanSquare(samples, start, n) {
  let sum=0;
  for(let i=start;i<start+n && i<samples.length;i++)sum+=samples[i]*samples[i];
  return sum/n;
}
function locatePreamble(samples,rate) {
  // Look for 300 ms of 1900 Hz followed by 100 ms of 1200 Hz.
  const ms=rate/1000;
  const max=Math.min(samples.length-Math.round(ms*410),Math.round(rate*180));
  if(max<0)throw new Error("Nagranie jest zbyt krótkie.");
  const step=Math.max(1,Math.round(ms*10));
  for(let off=0;off<=max;off+=step) {
    // Reject candidates that start during leading silence, not at pilot onset.
    const e1=meanSquare(samples,off,Math.round(ms*20));
    const e2=meanSquare(samples,off+Math.round(ms*50),Math.round(ms*20));
    if(e2<1e-4 || e1/e2<.80)continue;
    const a=power(samples,off+Math.round(ms*30),Math.round(ms*45),1900,rate);
    if(a<.55)continue;
    const b=power(samples,off+Math.round(ms*190),Math.round(ms*45),1900,rate);
    const c=power(samples,off+Math.round(ms*335),Math.round(ms*45),1200,rate);
    if(b>.55&&c>.50)return off;
  }
  throw new Error("Nie wykryto nagłówka synchronizacji 1900/1200 Hz.");
}
function readSymbols(samples, sampleStart, howManyBits, profile, rate) {
  const count=Math.ceil(howManyBits/profile.bits), bits=[];
  const n=Math.round(rate*profile.ms/1000);
  let previous=null, start=sampleStart;
  if(profile.kind==='ofdm') {
    const init=symbolBits(samples,start,profile,rate,null);
    previous=init.previous;start+=n;
  }
  for(let k=0;k<count;k++) {
    const got=symbolBits(samples,start,profile,rate,previous);
    bits.push(...got.bits);previous=got.previous;start+=n;
  }
  return bits.slice(0,howManyBits);
}
export function decodeDigital(samples,rate=RATE,profileName='ofdm') {
  requireRate(rate);
  const profile=PROFILES[profileName];
  if(!profile)throw new Error("Nieznany profil.");
  const start=locatePreamble(samples,rate);
  const headerBits=13*14;
  let lastError=null;
  // Small timing refinement for browser microphone / resampling jitter.
  for(const offsetMs of [0,-1,1,-2,2,-3,3,-4,4,-5,5]) {
    const dataStart=start+Math.round(rate*(400+offsetMs)/1000);
    if(dataStart<0)continue;
    try {
      const head=readSymbols(samples,dataStart,headerBits,profile,rate);
      const meta=readHeader(head);
      const total=headerBits+meta.length*(meta.fec?14:8);
      const full=readSymbols(samples,dataStart,total,profile,rate);
      return {...parseFrameBits(full), startSeconds:start/rate, profile:profileName};
    } catch(error){lastError=error;}
  }
  throw new Error("Nie udało się zdekodować ramek: "+(lastError?.message||"błąd synchronizacji"));
}
export function encodeSstv(rgba, width, height, modeName='robot36',rate=RATE) {
  requireRate(rate);
  const mode=MODES[modeName]; if(!mode)throw new Error("Nieznany tryb SSTV.");
  if(rgba.length!==width*height*4||width!==mode.width||height!==mode.height)
    throw new Error("Obraz musi mieć rozmiar właściwy dla wybranego trybu.");
  const len=width*height, y=new Float32Array(len), cr=new Float32Array(len), cb=new Float32Array(len);
  for(let i=0;i<len;i++){
    const r=rgba[i*4],g=rgba[i*4+1],b=rgba[i*4+2];
    y[i]=Math.max(0,Math.min(255,.299*r+.587*g+.114*b));
    cb[i]=Math.max(0,Math.min(255,128-.168736*r-.331264*g+.5*b));
    cr[i]=Math.max(0,Math.min(255,128+.5*r-.418688*g-.081312*b));
  }
  const synth=new Synth(rate);
  synth.tone(1900,300);synth.tone(1200,10);synth.tone(1900,300);synth.tone(1200,30);
  for(let bit=0;bit<7;bit++)synth.tone((mode.vis>>bit)&1?1100:1300,30);
  const oddParity=mode.vis.toString(2).split('1').length%2===0;
  synth.tone(oddParity?1100:1300,30);synth.tone(1200,30);
  for(let row=0;row<height;row++) {
    const base=row*width;
    synth.tone(1200,mode.sync);
    synth.tone(1500,mode.porch);
    synth.scan(y.subarray(base,base+width),mode.y);
    if(mode.pattern==='full') {
      synth.tone(1500,mode.sep);synth.tone(1900,mode.cporch);
      synth.scan(cr.subarray(base,base+width),mode.chroma);
      synth.tone(2300,mode.sep);synth.tone(1900,mode.cporch);
      synth.scan(cb.subarray(base,base+width),mode.chroma);
    } else if(mode.pattern==='pair') {
      const isCr=row%2===0;
      synth.tone(isCr?1500:2300,mode.sep);synth.tone(1900,mode.cporch);
      const selected=isCr?cr:cb, other=row%2===0?row+1:row-1;
      const values=new Float32Array(width);
      for(let x=0;x<width;x++)values[x]=(selected[base+x]+selected[other*width+x])*.5;
      synth.scan(values,mode.chroma);
    }
  }
  return synth.result();
}
function demodulate(samples,rate) {
  // Heterodyne + 1-pole baseband lowpass + smoothed phase discriminator.
  const out=new Float32Array(samples.length);
  const center=1900, step=PI2*center/rate, alpha=.085;
  let real=0, imag=0, prevReal=0, prevImag=0, smooth=center;
  for(let i=0;i<samples.length;i++) {
    const angle=step*i, s=samples[i];
    real+=alpha*(s*Math.cos(angle)-real);
    imag+=alpha*(-s*Math.sin(angle)-imag);
    const dot=real*prevReal+imag*prevImag;
    const cross=imag*prevReal-real*prevImag;
    const hz=center+rate*Math.atan2(cross,dot)/PI2;
    if(i>50 && Number.isFinite(hz))smooth+=.04*(Math.max(900,Math.min(2600,hz))-smooth);
    out[i]=smooth;
    prevReal=real;prevImag=imag;
  }
  return out;
}
export function decodeSstv(samples,rate=RATE,modeName='robot36') {
  requireRate(rate);
  const mode=MODES[modeName];if(!mode)throw new Error("Nieznany tryb SSTV.");
  const start=locateSstv(samples,rate);
  const lineMs=mode.sync+mode.porch+mode.y+(mode.pattern==='full'?2:mode.pattern==='pair'?1:0)*(mode.sep+mode.cporch+mode.chroma);
  const end=start+Math.round(rate*(910+lineMs*mode.height)/1000);
  if(samples.length<end-8)throw new Error("Niepełny obraz SSTV.");
  const freq=demodulate(samples,rate), count=mode.width*mode.height;
  const y=new Float32Array(count), cr=new Float32Array(count), cb=new Float32Array(count);
  cb.fill(128);cr.fill(128);
  const at=(startMs)=>Math.max(0,Math.min(freq.length-1,Math.round(start+rate*startMs/1000)));
  const video=(offsetMs,duration,arr,row)=>{
    const base=row*mode.width;
    for(let x=0;x<mode.width;x++) {
      const ms=offsetMs+(x+.5)*duration/mode.width;
      const center=at(ms), radius=Math.max(1,Math.round(rate*.00023));
      let sum=0;for(let k=center-radius;k<=center+radius;k++)sum+=freq[Math.max(0,Math.min(freq.length-1,k))];
      arr[base+x]=Math.max(0,Math.min(255,(sum/(2*radius+1)-1500)*255/800));
    }
  };
  for(let row=0;row<mode.height;row++) {
    let ms=910+row*lineMs+mode.sync+mode.porch;
    video(ms,mode.y,y,row);ms+=mode.y;
    if(mode.pattern==='full'){
      ms+=mode.sep+mode.cporch;video(ms,mode.chroma,cr,row);ms+=mode.chroma;
      ms+=mode.sep+mode.cporch;video(ms,mode.chroma,cb,row);
    }else if(mode.pattern==='pair'){
      ms+=mode.sep+mode.cporch;
      const plane=row%2===0?cr:cb;
      video(ms,mode.chroma,plane,row);
      if(row%2===1)cr.set(cr.subarray((row-1)*mode.width,row*mode.width),row*mode.width);
      else if(row+1<mode.height)cb.set(cb.subarray(row*mode.width,(row+1)*mode.width),(row+1)*mode.width);
    }
  }
  // Pair scans are transmitted as Cr on even, Cb on odd; replicate between corresponding rows.
  if(mode.pattern==='pair')for(let row=0;row<mode.height;row+=2) {
    if(row+1<mode.height){
      cr.set(cr.subarray(row*mode.width,(row+1)*mode.width),(row+1)*mode.width);
      cb.set(cb.subarray((row+1)*mode.width,(row+2)*mode.width),row*mode.width);
    }
  }
  const pixels=new Uint8ClampedArray(count*4);
  for(let i=0;i<count;i++) {
    const yy=y[i], rr=cr[i]-128, bb=cb[i]-128;
    pixels[i*4]=yy+1.402*rr;
    pixels[i*4+1]=yy-.344136*bb-.714136*rr;
    pixels[i*4+2]=yy+1.772*bb;
    pixels[i*4+3]=255;
  }
  return {width:mode.width,height:mode.height,pixels,startSeconds:start/rate};
}
function locateSstv(samples,rate) {
  const u=rate/1000, limit=Math.min(samples.length-Math.round(u*920),Math.round(rate*180));
  for(let i=0;i<=limit;i+=Math.max(1,Math.round(u*10))){
    if(power(samples,i+Math.round(u*80),Math.round(u*45),1900,rate)<.50)continue;
    if(power(samples,i+Math.round(u*301),Math.round(u*8),1200,rate)<.3)continue;
    if(power(samples,i+Math.round(u*415),Math.round(u*45),1900,rate)<.5)continue;
    return i;
  }
  throw new Error("Nie znaleziono nagłówka VIS SSTV.");
}
export function toWav(samples,rate=RATE) {
  requireRate(rate);
  const file=new ArrayBuffer(44+samples.length*2), v=new DataView(file);
  function str(off,text){for(let i=0;i<text.length;i++)v.setUint8(off+i,text.charCodeAt(i));}
  str(0,'RIFF');v.setUint32(4,file.byteLength-8,true);
  str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);
  v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
  str(36,'data');v.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++)v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
  return new Blob([file],{type:'audio/wav'});
}
export async function fromWav(blob) {
  const a=await blob.arrayBuffer(), v=new DataView(a);
  function str(off,n){return Array.from({length:n},(_,i)=>String.fromCharCode(v.getUint8(off+i))).join('');}
  if(a.byteLength<44||str(0,4)!=='RIFF'||str(8,4)!=='WAVE')throw new Error("Wymagany RIFF/WAVE.");
  let pos=12, fmt=null,chunk=null;
  while(pos+8<=a.byteLength){
    const name=str(pos,4),size=v.getUint32(pos+4,true);pos+=8;
    if(pos+size>a.byteLength)throw new Error("Uszkodzony WAV.");
    if(name==='fmt ')fmt={format:v.getUint16(pos,true),channels:v.getUint16(pos+2,true),
                           rate:v.getUint32(pos+4,true),depth:v.getUint16(pos+14,true)};
    if(name==='data'){chunk={offset:pos,size};break;}
    pos+=size+(size&1);
  }
  if(!fmt||!chunk||fmt.channels!==1 || !((fmt.format===1 && fmt.depth===16)||(fmt.format===3 && fmt.depth===32)))
    throw new Error("Obsługiwane WAV: PCM16 mono lub Float32 mono.");
  requireRate(fmt.rate);
  const n=chunk.size/(fmt.depth/8),out=new Float32Array(n);
  if(!Number.isInteger(n))throw new Error("Niepełna ramka PCM.");
  for(let i=0;i<n;i++)out[i]=fmt.format===1?v.getInt16(chunk.offset+i*2,true)/32768:v.getFloat32(chunk.offset+i*4,true);
  return {samples:out,rate:fmt.rate};
}
