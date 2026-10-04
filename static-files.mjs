import {readFileSync} from 'node:fs';
import path from 'node:path';

const files={
 '/':'index.html','/index.html':'index.html','/app.js':'app.js','/operations-ui.js':'operations-ui.js','/charts.js':'charts.js','/style.css':'style.css',
 '/assets/piano-studio-hero.png':'assets/piano-studio-hero.png','/assets/music-line.svg':'assets/music-line.svg'
};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
export function staticFile(root,url,method){
 if(!['GET','HEAD'].includes(method))return {status:405,type:'text/plain; charset=utf-8',body:'허용되지 않은 요청 방식'};
 const name=files[url];
 if(!name)return {status:404,type:'text/plain; charset=utf-8',body:'페이지를 찾을 수 없습니다'};
 try{return {status:200,type:types[path.extname(name)],body:readFileSync(path.join(root,'public',name))}}catch{return {status:404,type:'text/plain; charset=utf-8',body:'파일을 찾을 수 없습니다'}}
}
