#!/usr/bin/env python3
"""Compatibility entry point; use rseries_alertsim.py. Model support is unchanged."""
import runpy
from rseries_alertsim import *  # Preserve existing public imports.

if __name__ == '__main__':
    runpy.run_module('rseries_alertsim', run_name='__main__')
