import {RATE,MAX_PAYLOAD,MODES,PROFILES,estimateDuration,encodeDigital,decodeDigital,
  encodeSstv,decodeSstv,toWav,fromWav} from './codec.mjs';
import {GGWAVE_PROFILE,encodeGgwave,decodeGgwave} from './ggwave-adapter.mjs';

const $=id=>document.getElementById(id);
const utf8=new TextEncoder(),decoder=new TextDecoder();
let section='digital',payloadKind='text',audioData=null,outputUrl=null,receivedUrl=null,playing=null,recording=null;
let chunks=[],recordCount=0,recordRate=RATE,clock=null,wakeLock=null;

function message(text,error=false){
  $('status').textContent=text;
  $('status').style.color=error?'#e98e8e':'';
}
function switchSection(name){
  section=name;
  $('digital-settings').hidden=name!=='digital';
  $('sstv-settings').hidden=name!=='sstv';
  $('tab-digital').classList.toggle('active',name==='digital');
  $('tab-sstv').classList.toggle('active',name==='sstv');
  $('preview').hidden=true;
  estimate();
}
function switchPayload(name){
  payloadKind=name;
  $('digital-text-row').hidden=name!=='text';
  $('digital-file-row').hidden=name==='text';
  $('digital-file').value='';
  $('digital-file').accept=name==='image'?'image/*':'*/*';
  estimate();
}
function estimate(){
  if(section==='digital'){
    const n=utf8.encode($('message').value).length;
    const profile=$('profile').value;
    if(GGWAVE_PROFILE[profile]){message(GGWAVE_PROFILE[profile].label+' · maks. 128 B UTF-8 (tylko tekst)');return;}
    message(PROFILES[profile].label+
      (payloadKind==='text'?' · '+n+' B, około '+estimateDuration(n,profile,$('fec').checked).toFixed(1)+' s':' · maks. 4096 B'));
  }else{
    const mode=MODES[$('sstv-mode').value];
    const blocks=mode.pattern==='full'?2:mode.pattern==='pair'?1:0;
    const time=.91+mode.height*(mode.sync+mode.porch+mode.y+blocks*(mode.sep+mode.cporch+mode.chroma))/1000;
    message(mode.label+' · '+mode.width+' × '+mode.height+' · '+time.toFixed(2)+' s');
  }
}
function setDownload(blob,what,name){
  const url=URL.createObjectURL(blob);
  if(what==='wav'){
    if(outputUrl)URL.revokeObjectURL(outputUrl);outputUrl=url;
    $('wav-link').href=url;$('wav-link').download=name;$('wav-link').hidden=false;
    $('audio-preview').src=url;$('audio-preview').hidden=false;
  }else{
    if(receivedUrl)URL.revokeObjectURL(receivedUrl);receivedUrl=url;
    $('received-link').href=url;$('received-link').download=name;$('received-link').hidden=false;
  }
}
async function imageFrom(file){
  if(!file || !file.type.startsWith('image/'))throw Error('Wybierz obraz PNG lub JPEG.');
  return createImageBitmap(file,{imageOrientation:'from-image'});
}
function paintImage(image,width,height){
  const canvas=$('preview'),ctx=canvas.getContext('2d',{willReadFrequently:true});
  canvas.width=width;canvas.height=height;
  ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
  const scale=Math.min(width/image.width,height/image.height),w=image.width*scale,h=image.height*scale;
  ctx.drawImage(image,(width-w)/2,(height-h)/2,w,h);
  canvas.hidden=false;return canvas;
}
async function jpegBytes(file){
  const image=await imageFrom(file);
  try{
    const canvas=$('preview');
    for(const width of [200,160,128,96,72,48]){
      const height=Math.max(16,Math.round(width*image.height/image.width));
      paintImage(image,width,height);
      for(const quality of [.65,.45,.30]){
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
        if(blob && blob.size<=MAX_PAYLOAD)return new Uint8Array(await blob.arrayBuffer());
      }
    }
    throw Error('Obraz jest zbyt duży po kompresji (limit 4096 B).');
  }finally{image.close();}
}
async function readData(){
  if(payloadKind==='text')return {data:utf8.encode($('message').value),type:1};
  const file=$('digital-file').files[0];
  if(!file)throw Error('Wybierz plik.');
  if(payloadKind==='image')return {data:await jpegBytes(file),type:2};
  const name=utf8.encode(file.name);
  if(name.length>125||file.size+name.length+1>MAX_PAYLOAD)throw Error('Plik lub nazwa przekracza limit 4096 B.');
  const content=new Uint8Array(await file.arrayBuffer());
  const result=new Uint8Array(1+name.length+content.length);
  result[0]=name.length;result.set(name,1);result.set(content,name.length+1);
  return {data:result,type:3};
}
async function generate(){
  $('generate').disabled=true;message('Generowanie…');
  try{
    if(section==='digital'){
      const {data,type}=await readData();
      const selected=$('profile').value;
      if(GGWAVE_PROFILE[selected]){
        if(type!==1)throw Error('ggwave obsługuje tutaj tylko tekst. Do plików i zdjęć wybierz OFDM.');
        audioData=encodeGgwave(data,selected,RATE);
      }else audioData=encodeDigital(data,type,selected,$('fec').checked);
    }else{
      const selected=$('sstv-file').files[0];
      const image=await imageFrom(selected);
      try{
        const mode=MODES[$('sstv-mode').value],canvas=paintImage(image,mode.width,mode.height);
        const rgba=canvas.getContext('2d').getImageData(0,0,mode.width,mode.height).data;
        audioData=encodeSstv(rgba,mode.width,mode.height,$('sstv-mode').value);
      }finally{image.close();}
    }
    setDownload(toWav(audioData),'wav',section==='digital'?'modem_'+$('profile').value+'.wav':'sstv_'+$('sstv-mode').value+'.wav');
    $('play').disabled=false;
    message('[DONE] Wygenerowano '+(audioData.length/RATE).toFixed(2)+' s audio.');
  }catch(err){message('[FAIL] '+err.message,true);}
  finally{$('generate').disabled=false;}
}
async function stopPlay(){
  if(playing){
    const {context,source}=playing;playing=null;
    try{source.stop();}catch{}
    try{await context.close();}catch{}
  }
  $('play').disabled=!audioData;$('stop-play').disabled=true;
}
async function play(){
  if(!audioData)return;
  try{
    if(playing)await stopPlay();
    const context=new AudioContext({sampleRate:RATE});
    await context.resume();
    const buffer=context.createBuffer(1,audioData.length,RATE);
    buffer.copyToChannel(audioData,0);
    const source=context.createBufferSource();
    source.buffer=buffer;source.connect(context.destination);
    playing={context,source};
    $('play').disabled=true;$('stop-play').disabled=false;
    source.onended=()=>{if(playing?.source===source)stopPlay();};
    source.start();
  }catch(err){message('[FAIL] '+err.message,true);}
}
async function decoded(samples,rate){
  $('received').hidden=true;message('Dekodowanie…');
  await new Promise(resolve=>setTimeout(resolve,50));
  try{
    if(section==='digital'){
      const selected=$('profile').value;
      const data=GGWAVE_PROFILE[selected]?decodeGgwave(samples,rate):decodeDigital(samples,rate,selected);
      $('rx-info').textContent='CRC32 OK · '+data.data.length+' B · poprawione błędy FEC: '+data.corrected;
      if(data.type===1){
        $('rx-text').textContent=decoder.decode(data.data);$('rx-text').hidden=false;
        $('rx-image').hidden=true;$('received-link').hidden=true;
      }else if(data.type===2){
        const blob=new Blob([data.data],{type:'image/jpeg'});
        const img=await imageFrom(blob),canvas=$('rx-image');
        canvas.width=img.width;canvas.height=img.height;
        canvas.getContext('2d').drawImage(img,0,0);img.close();
        canvas.hidden=false;$('rx-text').hidden=true;
        setDownload(blob,'received','obraz_odebrany.jpg');
      }else{
        const n=data.data[0],name=decoder.decode(data.data.subarray(1,1+n)).replace(/[/\\]/g,'_')||'plik.bin';
        const file=data.data.subarray(1+n);
        $('rx-text').textContent='Odebrano: '+name+' ('+file.length+' B)';
        $('rx-text').hidden=false;$('rx-image').hidden=true;
        setDownload(new Blob([file]),'received',name);
      }
    }else{
      const data=decodeSstv(samples,rate,$('sstv-mode').value);
      const canvas=$('rx-image');canvas.width=data.width;canvas.height=data.height;
      canvas.getContext('2d').putImageData(new ImageData(data.pixels,data.width,data.height),0,0);
      canvas.hidden=false;$('rx-text').hidden=true;
      $('rx-info').textContent=MODES[$('sstv-mode').value].label+' · '+data.width+' × '+data.height;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      setDownload(blob,'received','sstv_odebrane.png');
    }
    $('received').hidden=false;message('[DONE] Dekodowanie zakończone.');
  }catch(err){message('[FAIL] '+err.message,true);}
}
async function importWav(){
  const file=$('wav-input').files[0];if(!file)return;
  try{const {samples,rate}=await fromWav(file);await decoded(samples,rate);}
  catch(err){message('[FAIL] '+err.message,true);}
}
async function startRecord(){
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){
    message('[FAIL] Mikrofon wymaga HTTPS w nowoczesnej przeglądarce.',true);return;
  }
  $('record').disabled=true;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{
      channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    const context=new AudioContext({sampleRate:RATE});
    await context.resume();
    await context.audioWorklet.addModule(new URL('./mic-worklet.js',import.meta.url));
    const source=context.createMediaStreamSource(stream);
    const worklet=new AudioWorkletNode(context,'pcm-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    const silent=context.createGain();silent.gain.value=0;
    source.connect(worklet);worklet.connect(silent);silent.connect(context.destination);
    chunks=[];recordCount=0;recordRate=context.sampleRate;
    recording={stream,context,source,worklet,silent};
    worklet.port.onmessage=e=>{
      if(!recording)return;
      const part=new Float32Array(e.data);
      if(recordCount+part.length>recordRate*180){stopRecord();return;}
      chunks.push(part);recordCount+=part.length;
      let sum=0;for(const x of part)sum+=x*x;
      $('record-level').value=Math.min(100,Math.round(Math.sqrt(sum/part.length)*200));
    };
    if(navigator.wakeLock)try{wakeLock=await navigator.wakeLock.request('screen');}catch{}
    $('stop-record').disabled=false;
    message('Nagrywanie mikrofonu PCM '+recordRate+' Hz…');
    clock=setInterval(()=>message('Nagrywanie: '+(recordCount/recordRate).toFixed(1)+' s / 180 s'),1000);
  }catch(err){$('record').disabled=false;message('[FAIL] Mikrofon: '+err.message,true);}
}
async function stopRecord(){
  if(!recording)return;
  const rec=recording;recording=null;
  clearInterval(clock);
  $('record').disabled=false;$('stop-record').disabled=true;
  try{rec.source.disconnect();rec.worklet.disconnect();rec.silent.disconnect();}catch{}
  rec.stream.getTracks().forEach(t=>t.stop());
  try{await rec.context.close();}catch{}
  if(wakeLock){try{await wakeLock.release();}catch{}wakeLock=null;}
  if(!recordCount){message('[FAIL] Brak nagranego dźwięku.',true);return;}
  const samples=new Float32Array(recordCount);
  let offset=0;for(const part of chunks){samples.set(part,offset);offset+=part.length;}
  chunks=[];recordCount=0;
  await decoded(samples,recordRate);
}
$('tab-digital').addEventListener('click',()=>switchSection('digital'));
$('tab-sstv').addEventListener('click',()=>switchSection('sstv'));
for(const radio of document.querySelectorAll('[name=payload]'))
  radio.addEventListener('change',()=>{if(radio.checked)switchPayload(radio.value);});
for(const id of ['profile','sstv-mode','fec','message','digital-file','sstv-file'])
  $(id).addEventListener('change',estimate);
$('generate').addEventListener('click',generate);
$('play').addEventListener('click',play);
$('stop-play').addEventListener('click',stopPlay);
$('record').addEventListener('click',startRecord);
$('stop-record').addEventListener('click',stopRecord);
$('wav-input').addEventListener('change',importWav);
window.addEventListener('pagehide',()=>{if(recording)stopRecord();if(playing)stopPlay();});
if('serviceWorker' in navigator && window.isSecureContext)
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
switchSection('digital');
