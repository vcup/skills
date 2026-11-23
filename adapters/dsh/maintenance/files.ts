/** Trusted destination publication; parent directory descriptors prevent path-swap redirection. */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { privateDirectory, digestBytes } from "../uploads/index.ts";
import { StoreFault } from "../store/kernel.ts";
import { safeLogicalPath } from "./handles.ts";
export interface OutputFile { path:string; bytes:Uint8Array }
function present(path:string):boolean { try { lstatSync(path);return true; } catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;} }
export function readRegular(path:string,maxBytes=512*1024*1024):Uint8Array {
  privateDirectory(dirname(path));
  const parent=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    if(realpathSync(`/proc/self/fd/${parent}`)!==dirname(path))throw new Error("file parent changed");
    const fd=openSync(`/proc/self/fd/${parent}/${basename(path)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {const st=fstatSync(fd);if(!st.isFile()||st.size>maxBytes)throw new Error("file is unsafe or exceeds budget");const bytes=readFileSync(fd);if(bytes.length>maxBytes)throw new Error("file grew beyond budget");return bytes;}finally{closeSync(fd);}
  }finally{closeSync(parent);}
}
export function publishDirectory(destination:string,files:readonly OutputFile[]):void {
  const parent=dirname(destination);privateDirectory(parent);
  const parentFd=openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const identity=fstatSync(parentFd);const anchor=`/proc/self/fd/${parentFd}`;
  const stillSelected=()=>{privateDirectory(parent);const st=lstatSync(parent);return st.dev===identity.dev&&st.ino===identity.ino&&realpathSync(anchor)===parent;};
  try {
    if(!stillSelected())throw new Error("destination parent changed");
    const target=join(anchor,basename(destination));if(present(target))throw new Error("destination_exists");
    const stage=join(anchor,`.ensemble-stage-${randomUUID()}`);mkdirSync(stage,{mode:0o700});
    const names=new Set<string>();const dirs=new Set<string>([stage]);
    for(const file of files){
      if(!safeLogicalPath(file.path)||names.has(file.path))throw new Error("unsafe or duplicate export path");names.add(file.path);
      let dir=stage;for(const segment of file.path.split("/").slice(0,-1)){dir=join(dir,segment);if(!present(dir))mkdirSync(dir,{mode:0o700});const st=lstatSync(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error("unsafe export subdirectory");dirs.add(dir);}
      const path=join(stage,file.path);const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{writeFileSync(fd,file.bytes);fsyncSync(fd);}finally{closeSync(fd);}
      const verify=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(digestBytes(readFileSync(verify))!==digestBytes(file.bytes))throw new Error("export verification failed");}finally{closeSync(verify);}
    }
    for(const dir of [...dirs].reverse()){const fd=openSync(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
    if(!stillSelected())throw new Error("destination parent changed before publication");
    // Exclusive reservation followed by atomic replacement of our own empty directory only.
    mkdirSync(target,{mode:0o700});const reservation=lstatSync(target);
    try {const checked=lstatSync(target);if(checked.ino!==reservation.ino||checked.dev!==reservation.dev)throw new Error("destination reservation changed");renameSync(stage,target);}
    catch(error){const checked=lstatSync(target);if(checked.ino===reservation.ino&&checked.dev===reservation.dev)rmdirSync(target);throw error;}
    fsyncSync(parentFd);
    if(!stillSelected())throw new StoreFault("outcome_unknown","destination moved after publication; reconcile its manifest before retrying");
  }finally{closeSync(parentFd);}
}
