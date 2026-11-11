from pathlib import Path

assert Path("seed.txt").read_text() == "isolated real tool read\n"
print("ANDROID_PROJECT_TEST_OK")
