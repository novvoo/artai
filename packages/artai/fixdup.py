p='src/core/prompt/compile.ts'
s=open(p).read()
dup='''    : "";
    // ---------- paragraph 3 ----------'''
fixed='''    : "";

  // paragraph 3 assembly happens after P2 build below'''
assert dup in s
s=s.replace(dup,fixed,1)
open(p,'w').write(s)
print("step done")
