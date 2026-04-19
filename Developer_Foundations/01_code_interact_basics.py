"""
Demo 1: code.interact() basics
Run this and interact with the shell to inspect variables.
Exit with Ctrl+D to continue, or exit() to terminate.
"""
import code

name = "Dhwani"
cgpa = 9.79
subjects = ["IP", "CN", "TOC", "DSA", "OS"]

print("Before interact")
print(f"Name: {name}, CGPA: {cgpa}, Subjects: {subjects}")
print("Exit with Ctrl+Z (win) to continue, exit() to stop\n")

code.interact(local=locals())

print("You continued after interact because you used Ctrl+D. If you used exit(), this line won't be printed.")
print("After interact")
print(f"Name: {name}, CGPA: {cgpa}, Subjects: {subjects}")