import {readdirSync,readFileSync,statSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const parse=file=>JSON.parse(readFileSync(path.join(root,file),'utf8').replace(/^\uFEFF/,''));
const problems=[];
const ignoredDirs=new Set(['.git','node_modules','data','work','backups','logs','.cache','coverage','.aws','.ssh']);
const examples=new Set(['.env.production.example','.env.development.example']);
function forbidden(file){
  const parts=file.replaceAll('\\','/').split('/');
  const base=parts.at(-1);
  return parts.some(p=>ignoredDirs.has(p)&&p!=='.git') ||
    (base.startsWith('.env')&&!examples.has(file)) ||
    /\.(?:sqlite[^/]*|db(?:-[^/]*)?|pdmbak|log|pem|key|p12|pfx|zip|tmp)$/i.test(base) ||
    /\.scratch-/i.test(base) || ['.npmrc','.netrc'].includes(base);
}
function walk(folder,prefix=''){
  const result=[];
  for(const item of readdirSync(folder,{withFileTypes:true})){
    const relative=prefix+item.name;
    if(item.isSymbolicLink()){problems.push(`Symbolic link: ${relative}`);continue;}
    if(item.isDirectory()){
      if(!ignoredDirs.has(item.name))result.push(...walk(path.join(folder,item.name),relative+'/'));
    }else result.push(relative);
  }
  return result;
}
const diskFiles=walk(root);
let tracked=[];
try{
  const gitTop=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  // Do not accidentally examine a parent repository that owns more than this bundle.
  if(path.resolve(gitTop)===root)tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
}catch{}
const files=[...new Set([...diskFiles,...tracked])];
for(const file of files){
  if(forbidden(file)){problems.push(`Excluded artifact: ${file}`);continue;}
  const absolute=path.resolve(root,file);
  if(!absolute.startsWith(root+path.sep)){problems.push('Path escapes repository root');continue;}
  if(!existsSync(absolute)||!statSync(absolute).isFile())continue;
  const raw=readFileSync(absolute);
  if(raw.subarray(0,16).toString('binary')==='SQLite format 3\0')problems.push(`Database contents: ${file}`);
  if(/\.(?:png|webp|jpg|jpeg|avif|gif|ico)$/i.test(file))continue;
  const content=raw.toString('utf8');
  const highConfidenceSecret=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b|\bAKIA[A-Z0-9]{16}\b/;
  if(highConfidenceSecret.test(content))problems.push(`Possible credential in: ${file}`);
}
const rules=parse('SOURCE-ALLOWLIST.json');
const extraFiles=parse('BUNDLE-EXTRAS.json');
const permittedFiles=new Set([...rules.files.map(entry=>entry.target),...extraFiles]);
for(const file of files){
  if(!permittedFiles.has(file))problems.push(`Unreviewed file: ${file}`);
}
for(const file of extraFiles){
  if(!existsSync(path.join(root,file)))problems.push(`Missing bundle file: ${file}`);
}
for(const entry of rules.files){
  if(forbidden(entry.target))problems.push(`Forbidden allowlist target: ${entry.target}`);
  if(!existsSync(path.join(root,entry.target)))problems.push(`Missing allowlist target: ${entry.target}`);
}
if(process.argv.includes('--verify-snapshot')){
  const snapshot=parse('SOURCE-MANIFEST.json');
  for(const record of snapshot.files){
    const file=path.join(root,record.target);
    if(!existsSync(file))continue;
    if(createHash('sha256').update(readFileSync(file)).digest('hex')!==record.sha256)problems.push(`Snapshot differs: ${record.target}`);
  }
}
const pkg=parse('package.json');
if(pkg.engines?.node!=='>=24')problems.push('Review Node engine requirement');
if(problems.length){
  console.error(JSON.stringify({ok:false,problems},null,2));
  process.exitCode=1;
}else console.log(JSON.stringify({ok:true,files_checked:files.length,allowlisted_sources:rules.files.length,version:pkg.version,snapshot_verified:process.argv.includes('--verify-snapshot'),scope:'File policy and selected credential signatures; not a complete privacy or secret audit.'}));

