import {readFileSync,writeFileSync,existsSync,mkdirSync,realpathSync} from 'node:fs';
import {deflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
if(!process.argv[2])throw Error('Provide a new archive path outside the bundle');
const target=path.resolve(process.argv[2]);
const relative=path.relative(root,target);
if((!relative.startsWith('..'+path.sep)&&relative!=='..')||!target.toLowerCase().endsWith('.zip'))throw Error('Choose a ZIP path outside the source bundle');
if(existsSync(target))throw Error('Existing archives are not overwritten');
const check=spawnSync(process.execPath,[path.join(root,'scripts/verify-repository.mjs'),'--verify-snapshot'],{cwd:root,encoding:'utf8'});
if(check.status!==0){process.stderr.write(check.stderr||check.stdout);process.exit(check.status||1)}
const parse=file=>JSON.parse(readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));
const rules=parse('SOURCE-ALLOWLIST.json'),extras=parse('BUNDLE-EXTRAS.json');
const files=[...new Set([...rules.files.map(entry=>entry.target),...extras])].sort();
if(files.length>65535)throw Error('Too many entries for this ZIP format');
const table=Uint32Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0});
const crc32=raw=>{let crc=0xffffffff;for(const byte of raw)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0};
const entries=[],directory=[];let offset=0;
// ZIP timestamps are an informational fixed KST date, not a source-history claim.
const dosDate=((2026-1980)<<9)|(10<<5)|4;
for(const file of files){
  const absolute=path.resolve(root,file),name=Buffer.from(file,'utf8');
  if(path.relative(root,realpathSync(absolute)).startsWith('..'+path.sep))throw Error('Entry escapes bundle');
  const raw=readFileSync(absolute),compressed=deflateRawSync(raw),crc=crc32(raw);
  if(raw.length>0xffffffff||compressed.length>0xffffffff||offset>0xffffffff)throw Error('Entry requires ZIP64');
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(dosDate,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(raw.length,22);header.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(dosDate,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  entries.push(header,name,compressed);directory.push(central,name);offset+=header.length+name.length+compressed.length;
}
const centralData=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralData.length,12);end.writeUInt32LE(offset,16);
const archive=Buffer.concat([...entries,centralData,end]);
mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,archive,{flag:'wx'});
console.log(JSON.stringify({entries:files.length,bytes:archive.length,sha256:createHash('sha256').update(archive).digest('hex'),remote_operation:false}));

