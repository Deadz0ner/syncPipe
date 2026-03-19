function uint8ToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
const b = new Uint8Array(200);
for(let i=0; i<200; i++) b[i]=i;
console.log(uint8ToBase64(b.buffer));
