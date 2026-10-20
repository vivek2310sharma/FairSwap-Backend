import type {ChildProcessWithoutNullStreams} from "node:child_process";
type Actor={user?:string;password?:string;timeout?:number};
export function query(sql:string,options?:Actor):string;
export function raw(sql:string,options?:Actor):{status:number|null;stdout:string;stderr:string};
export function stream(sql:string,options?:Actor):ChildProcessWithoutNullStreams;
export function inspect():Record<string,unknown>;
export function scramVerifier(password:string):string;
