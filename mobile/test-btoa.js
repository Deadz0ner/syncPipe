const buffer = new Uint8Array([255, 200, 100, 50, 0, 255]);
let binary = "";
for(let i=0; i<buffer.byteLength; i++) binary += String.fromCharCode(buffer[i]);
console.log(btoa(binary));
