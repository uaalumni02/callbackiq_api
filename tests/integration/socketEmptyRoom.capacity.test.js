import http from 'node:http';
import {Server} from 'socket.io';
import {io as connect} from 'socket.io-client';
import {Adapter} from 'socket.io-adapter';
import SocketService from '../../src/services/socket.service.js';
afterEach(()=>SocketService.reset());
test('empty built-in rooms skip serialization; subscribed business rooms retain delivery and isolation',async()=>{
 const server=http.createServer();const io=new Server(server);SocketService.initialize(io);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const clients=[];
 try{
  expect(io.sockets.adapter.constructor).toBe(Adapter);
  const payload={toJSON(){throw new Error('An empty room must not serialize');}};
  expect(SocketService.emitToBusiness('absent','test',payload)).toBe(true);
  io.on('connection',socket=>socket.on('join',(business,ack)=>{socket.join(`business:${business}`);ack();}));
  for(const business of ['a','b']){
   const client=connect(`http://127.0.0.1:${server.address().port}`,{transports:['websocket']});clients.push(client);
   await new Promise(resolve=>client.once('connect',resolve));await new Promise(resolve=>client.emit('join',business,resolve));
  }
  const received=[];clients[1].on('test',value=>received.push(value));
  const delivered=new Promise(resolve=>clients[0].once('test',resolve));
  SocketService.emitToBusiness('a','test',{value:'Tenant A'});
  expect(await delivered).toEqual({value:'Tenant A'});await new Promise(resolve=>setTimeout(resolve,20));expect(received).toEqual([]);
 }finally{clients.forEach(c=>c.disconnect());await new Promise(resolve=>io.close(resolve));}
});
test('custom cluster adapters broadcast even when the local room is empty',()=>{
 class ClusterAdapter extends Adapter {}
 const emit=jest.fn();const adapter=Object.create(ClusterAdapter.prototype);adapter.rooms=new Map();
 SocketService.initialize({sockets:{adapter},to:jest.fn(()=>({emit}))});
 expect(SocketService.emitToBusiness('remote','test',{value:1})).toBe(true);expect(emit).toHaveBeenCalledWith('test',{value:1});
});
