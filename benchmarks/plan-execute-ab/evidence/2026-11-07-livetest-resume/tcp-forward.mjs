// Plain byte forwarder: 127.0.0.1:<local> -> <host>:<port>. Scratch helper only; no payload changes.
import net from 'node:net';
const [localPort, host, port] = process.argv.slice(2);
const server = net.createServer(client => {
  const upstream = net.connect({ host, port: Number(port) });
  client.pipe(upstream); upstream.pipe(client);
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on('error', end); upstream.on('error', end);
  client.on('close', end); upstream.on('close', end);
});
server.listen(Number(localPort), '127.0.0.1', () => console.log(`forwarding 127.0.0.1:${localPort} -> ${host}:${port}`));
