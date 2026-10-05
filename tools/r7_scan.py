#!/usr/bin/env python3
"""Compatibility entry point; use rseries_scan.py. Model support is unchanged."""
import runpy
from rseries_scan import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_scan', run_name='__main__')
