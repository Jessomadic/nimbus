// Tiny pub/sub for pushing live updates to every open browser tab (server-sent events).
const clients = new Map();

export function addClient(res,{authorized=()=>true,sessionToken=null}={}) {
  clients.set(res,{authorized,sessionToken});
  res.on('close', () => clients.delete(res));
}
export function revokeClients(sessionToken){for(const [res,client] of clients)if(client.sessionToken===sessionToken){clients.delete(res);res.end();}}
export function revalidateClients(){for(const [res,client] of clients)if(!client.authorized()){clients.delete(res);res.end();}}

export function broadcast(type, data) {
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  revalidateClients();for (const res of clients.keys()) res.write(line);
}

setInterval(() => { revalidateClients();for (const res of clients.keys()) res.write(': ping\n\n'); }, 10000).unref();
