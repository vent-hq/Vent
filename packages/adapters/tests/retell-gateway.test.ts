import test from "node:test";
import assert from "node:assert/strict";
const wrtc: typeof import("@roamhq/wrtc") = require("@roamhq/wrtc");
import { RetellGateway } from "../src/retell-gateway.js";

test("Retell v3 signaling carries bidirectional PCM and deletes the media session", async () => {
  const originalFetch = globalThis.fetch;
  const remote = new wrtc.RTCPeerConnection({iceServers:[]});
  const source = new wrtc.nonstandard.RTCAudioSource();
  const track = source.createTrack();
  remote.addTrack(track);
  let sink: InstanceType<typeof wrtc.nonstandard.RTCAudioSink> | undefined;
  let receivedPeak=0;
  let agentPeak=0;
  let deleted=false;
  let clock: ReturnType<typeof setInterval> | undefined;
  const errors: Error[]=[];
  let control: {close():void} | undefined;
  remote.ondatachannel=(event: {channel:{close():void}})=>{control=event.channel;};
  let hungUp!: ()=>void;
  const disconnected=new Promise<void>(resolve=>{hungUp=resolve;});
  remote.ontrack=(event: {track:unknown})=>{
    sink=new wrtc.nonstandard.RTCAudioSink(event.track);
    sink.ondata=(data: {samples:Int16Array})=>{ for(const n of data.samples)receivedPeak=Math.max(receivedPeak,Math.abs(n)); };
  };
  const gateway=new RetellGateway({
    audio(pcm){for(let i=0;i<pcm.length;i+=2)agentPeak=Math.max(agentPeak,Math.abs(pcm.readInt16LE(i)));},
    disconnected(){hungUp();},error(error){errors.push(error);},
  });
  globalThis.fetch=(async (input,init)=>{
    const url=String(input);
    if(url.endsWith("/v3/create-web-call")) {
      assert.equal(JSON.parse(String(init?.body)).agent_id,"agent-test");
      return Response.json({call_id:"call-test",access_token:"test-token",transport:"gateway",ice_servers:[]});
    }
    assert.equal(new Headers(init?.headers).get("Authorization"),"Bearer test-token");
    if(init?.method==="POST") {
      const offer=JSON.parse(String(init.body));
      assert.equal(offer.identity,"client");
      await remote.setRemoteDescription({type:"offer",sdp:offer.sdp});
      await remote.setLocalDescription(await remote.createAnswer());
      await new Promise<void>(resolve=>{
        if(remote.iceGatheringState==="complete")resolve();
        else remote.onicegatheringstatechange=()=>{if(remote.iceGatheringState==="complete")resolve();};
      });
      let phase=0;
      clock=setInterval(()=>{
        const samples=new Int16Array(480);
        for(let i=0;i<samples.length;i++)samples[i]=Math.round(Math.sin(phase++*2*Math.PI*440/48000)*4000);
        source.onData({samples,sampleRate:48000,bitsPerSample:16,channelCount:1,numberOfFrames:480});
      },10);
      return Response.json({session_id:"session-test",sdp:remote.localDescription!.sdp});
    }
    if(init?.method==="DELETE") {deleted=true;return new Response(null,{status:204});}
    throw new Error("Unexpected signaling request");
  }) as typeof fetch;
  try {
    assert.equal(await gateway.connect("key-test","agent-test"),"call-test");
    let phase=0;
    for(let frame=0;frame<100;frame++) {
      const samples=new Int16Array(480);
      for(let i=0;i<samples.length;i++)samples[i]=Math.round(Math.sin(phase++*2*Math.PI*600/48000)*4000);
      gateway.writeFrame(samples);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(receivedPeak>1000,"provider received injected caller audio");
    assert.ok(agentPeak>1000,"caller received provider audio");
    assert.deepEqual(errors,[]);
    control!.close(); // Retell hanging up
    await disconnected;
  } finally {
    await gateway.close();
    if(clock)clearInterval(clock);
    sink?.stop();track.stop();
    for(const receiver of remote.getReceivers())receiver.track.stop();
    remote.close();
    globalThis.fetch=originalFetch;
  }
  assert.equal(deleted,true);
});

test("Retell credit exhaustion fails before allocating media resources", async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({message:"Credit balance exhausted"},{status:402});
  const gateway=new RetellGateway({audio(){},disconnected(){},error(){}});
  try {await assert.rejects(gateway.connect("test","test"),/402.*Credit balance exhausted/);}
  finally {await gateway.close();globalThis.fetch=original;}
});
