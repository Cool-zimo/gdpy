from setuptools import find_packages, setup

setup(
    name='gdpy',
    version='0.0.1',
    description='GitHub Drive 桌面版（Tkinter）',
    packages=find_packages(),
    python_requires='>=3.8',
    entry_points={'console_scripts': ['gdpy=main:main']},
)
