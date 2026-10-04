import {readFileSync,writeFileSync,existsSync,mkdirSync,realpathSync,lstatSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const parse=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const rules=parse(path.join(root,'SOURCE-ALLOWLIST.json'));
const source=realpathSync(path.resolve(root,process.argv[2]||rules.source));
if(source===root)throw Error('Source and destination must differ');
const inside=(base,file)=>{const relative=path.relative(base,file);return relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)};
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const files=[];
const seen=new Set();
for(const entry of rules.files){
  const from=path.resolve(source,entry.source),target=path.resolve(root,entry.target);
  if(!inside(source,from)||!inside(root,target))throw Error('Allowlist path escapes its root');
  if(/(^|\/)(data|work|backups|logs|node_modules)\/|\.(sqlite[^/]*|db|pdmbak|log|pem|key|p12|pfx)$/.test(entry.source))throw Error('Forbidden source in allowlist');
  if(seen.has(entry.target))throw Error('Duplicate target');
  seen.add(entry.target);
  if(lstatSync(from).isSymbolicLink()||!inside(source,realpathSync(from)))throw Error('Source link escapes allowlist');
  if(!statSync(from).isFile())throw Error('Source must be a regular file');
  mkdirSync(path.dirname(target),{recursive:true});
  if(!inside(root,realpathSync(path.dirname(target)))&&realpathSync(path.dirname(target))!==root)throw Error('Target directory escapes bundle');
  if(existsSync(target)&&lstatSync(target).isSymbolicLink())throw Error('Target links are not accepted');
  const raw=readFileSync(from),hash=sha(raw);
  writeFileSync(target,raw);
  if(sha(readFileSync(from))!==hash||sha(readFileSync(target))!==hash)throw Error('Source changed during copying');
  files.push({source:entry.source,target:entry.target,bytes:raw.length,sha256:hash});
}
for(const record of files)if(sha(readFileSync(path.join(source,record.source)))!==record.sha256)throw Error('Source changed during preparation; retry after source freeze');
const pkg=parse(path.join(root,'package.json'));
writeFileSync(path.join(root,'SOURCE-MANIFEST.json'),JSON.stringify({prepared_at_utc:new Date().toISOString(),project:pkg.name,version:pkg.version,source_label:'academy-operations; reviewed implementation snapshot',uploaded:false,deployed:false,files,excluded:['data','work','SQLite/deletion journal','backups','logs','actual environment files','private keys','real academy data']},null,2)+'\n');
console.log(JSON.stringify({prepared:files.length,version:pkg.version,remote_operation:false}));

