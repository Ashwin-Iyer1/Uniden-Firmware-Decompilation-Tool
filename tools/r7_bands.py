#!/usr/bin/env python3
"""Compatibility entry point; use rseries_bands.py. Model support is unchanged."""
import runpy
from rseries_bands import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_bands', run_name='__main__')
