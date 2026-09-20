import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('..',import.meta.url));
const output=resolve(process.argv[2]||join(root,'dist'));
const version=JSON.parse(readFileSync(join(root,'package.json'))).version;
const lock=JSON.parse(readFileSync(join(root,'package-lock.json')));
const stage=mkdtempSync(join(tmpdir(),'postplan-cli-build-'));
try {
  mkdirSync(output,{recursive:true});
  mkdirSync(join(stage,'bin'));mkdirSync(join(stage,'src'));
  let cli=readFileSync(join(root,'node_modules/postplan/bin/postplan.js'),'utf8');
  if(!cli.includes('registerReviewCommands') || !cli.includes('POSTPLAN_CONFIG_DIR')) throw new Error('Run npm run patch after npm ci before building');
  const before='const DEFAULT_API_URL = "https://postplan.dev";';
  if(cli.split(before).length!==2) throw new Error('Upstream CLI URL contract changed');
  cli=cli.replace(before,'const DEFAULT_API_URL = "https://postplan.restot.top";');
  writeFileSync(join(stage,'bin/postplan.js'),cli);chmodSync(join(stage,'bin/postplan.js'),0o755);
  copyFileSync(join(root,'node_modules/postplan/src/html-policy.js'),join(stage,'src/html-policy.js'));
  copyFileSync(join(root,'review-cli.js'),join(stage,'src/review-cli.js'));
  for(const file of ['LICENSE','UPSTREAM-LICENSE','README.md']) copyFileSync(join(root,file),join(stage,file));
  const dependencies={};
  // Bundle only the CLI's three pure-JavaScript dependencies, including their license files.
  for(const name of ['commander','parse5','entities']) {
    const path=join(root,'node_modules',name);
    const pkg=JSON.parse(readFileSync(join(path,'package.json')));
    if(pkg.version!==lock.packages[`node_modules/${name}`].version) throw new Error(`Dependency differs from lock: ${name}`);
    dependencies[name]=pkg.version;
    cpSync(path,join(stage,'node_modules',name),{recursive:true,dereference:true});
  }
  const manifest={name:'@restot/postplan',version,description:'CLI for the self-hosted Restot Postplan build',type:'module',license:'MIT',engines:{node:'>=22'},bin:{postplan:'bin/postplan.js'},repository:{type:'git',url:'https://github.com/restot/postplan.git'},files:['bin/','src/','LICENSE','UPSTREAM-LICENSE','README.md'],dependencies,bundledDependencies:Object.keys(dependencies)};
  writeFileSync(join(stage,'package.json'),JSON.stringify(manifest));
  const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',output],{cwd:stage,encoding:'utf8'}));
  const file=packed[0].filename;
  const digest=createHash('sha256').update(readFileSync(join(output,file))).digest('hex');
  writeFileSync(join(output,'SHA256SUMS'),`${digest}  ${file}\n`);
  console.log(join(output,file));
} finally {rmSync(stage,{recursive:true,force:true});}
