from api import save as persist

def entry():
    persist()

def dynamic(callback):
    callback()
