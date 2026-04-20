"""
Demo 3: pdb basics
Run this and use pdb commands:
  p x    - print x
  p y    - print y
  s      - step into the add() function
  n      - next line (don't step into functions)
  c      - continue execution
  b 11   - set breakpoint at line 11
  q      - quit
"""

def add(x, y):
    return x + y

a = 5
b = 10
breakpoint()  # This will drop us into the debugger here

c = add(a, b)
print(f"The result of adding {a} and {b} is: {c}")