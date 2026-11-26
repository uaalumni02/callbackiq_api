/** Models a Mongoose read query for isolated unit fixtures, preserving both await and lean/select chaining. */
export function modelQuery(value) {
 const query={lean:async()=>value,then:(resolve,reject)=>Promise.resolve(value).then(resolve,reject)};
 for(const name of ['select','populate','sort','limit','session'])query[name]=()=>query;
 return query;
}
