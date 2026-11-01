class PcmCapture extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(4096);this.index=0;}
  process(inputs,outputs){
    const input=inputs[0]?.[0];
    if(input)for(const sample of input){
      this.buffer[this.index++]=sample;
      if(this.index===4096){this.port.postMessage(this.buffer,[this.buffer.buffer]);this.buffer=new Float32Array(4096);this.index=0;}
    }
    for(const output of outputs)for(const channel of output)channel.fill(0);
    return true;
  }
}
registerProcessor('pcm-capture',PcmCapture);