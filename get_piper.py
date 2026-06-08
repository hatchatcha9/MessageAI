import urllib.request, os
os.makedirs(os.path.expanduser('~/piper-voices'), exist_ok=True)
base = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/amy/medium/'
for f in ['en_US-amy-medium.onnx', 'en_US-amy-medium.onnx.json']:
    dest = os.path.expanduser(f'~/piper-voices/{f}')
    print(f'Downloading {f}...')
    urllib.request.urlretrieve(base + f, dest)
    print(f'  -> {dest}')
print('Done.')
