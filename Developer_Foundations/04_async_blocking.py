"""
Demo 4: Blocking (synchronous) code
Run this first, then run 05_async_nonblocking.py to see the difference.
"""
import time

def say_hello():
    time.sleep(2)
    print("Hello World!")

def say_good_bye():
    time.sleep(2)
    print("GoodBye World!")

start = time.time()
say_hello()
say_good_bye()
total = time.time() - start
print(f"Total time for BLOCKING version: {total:.2f} seconds")
print("(Each function waited for the other to finish)")
