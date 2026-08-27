p='src/core/prompt/compile.ts'
lines=open(p).read().split('\n')
# remove FIRST photoPart declaration (orphan left from earlier P1 area), keep the later full one within P2 build
first=next(i for i,l in enumerate(lines) if l.strip().startswith('const photoPart'))
# also drop its 3 continuation lines
del lines[first:first+3]
open(p,'w').write('\n'.join(lines))
print('removed orphan at', first+1)
