export const deepOverride = (target: any, ...sources: any) => {
    if (typeof target !== 'object' || target === null) {
       return target;
    }
 
    for (const source of sources) {
       for (const key in source) {
          if (source.hasOwnProperty(key)) {
             if (typeof source[key] === 'object' && source[key] !== null) {
                if (Array.isArray(source[key])) {
                   target[key] = Array.isArray(target[key]) ? target[key] : [];
                   target[key] = target[key].map((item: any, index: number) => 
                      deepOverride(item, source[key][index] || {})
                   );
                   target[key].push(...source[key].slice(target[key].length));
                } else {
                   target[key] = deepOverride(target[key] || {}, source[key]);
                }
             } else {
                target[key] = source[key];
             }
          }
       }
    }
    return target;
 }