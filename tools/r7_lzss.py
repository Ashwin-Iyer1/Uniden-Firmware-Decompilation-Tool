#!/usr/bin/env python3
"""Compatibility entry point; use rseries_lzss.py. Model support is unchanged."""
import runpy
from rseries_lzss import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_lzss', run_name='__main__')
