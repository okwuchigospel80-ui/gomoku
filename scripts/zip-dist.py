import os
import zipfile

os.chdir('dist')
with zipfile.ZipFile('../gomoku-static.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirnames, files in os.walk('.'):
        for name in files:
            full = os.path.join(dirpath, name)
            arc = os.path.relpath(full, '.').replace(os.sep, '/')
            z.write(full, arc)
print('rewritten')
