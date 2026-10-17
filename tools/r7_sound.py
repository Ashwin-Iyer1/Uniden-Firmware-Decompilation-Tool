#!/usr/bin/env python3
"""Compatibility entry point; use rseries_sound.py. Model support is unchanged."""
import runpy
from rseries_sound import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_sound', run_name='__main__')
