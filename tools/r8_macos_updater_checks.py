#!/usr/bin/env python3
"""Offline checks of exact v2.22 x86-64 updater instructions (no device I/O).

Requires Unicorn. The proprietary input is supplied locally and never copied
into the report. These checks cover an isolated copy/dispatch window and the
legacy transform, not the whole application or an R8 alert.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from unicorn import Uc, UC_ARCH_X86, UC_MODE_64, UC_HOOK_CODE
from unicorn.x86_const import (UC_X86_REG_RAX, UC_X86_REG_RBP, UC_X86_REG_RCX,
                              UC_X86_REG_RDI, UC_X86_REG_RDX, UC_X86_REG_RIP,
                              UC_X86_REG_RSI, UC_X86_REG_RSP, UC_X86_REG_R8,
                              UC_X86_REG_R9)

EXPECTED_SHA256 = 'e9f58c4d3c3c8635dd038fef4acfda731a760d084aa0b70fc77e50508358b4c2'
BASE = 0x100000000
STACK = 0x2000000
SOURCE = 0x4000000
RETURN = 0x3000000

def make_vm(binary):
    uc = Uc(UC_ARCH_X86, UC_MODE_64)
    pos = 32
    for _ in range(struct.unpack_from('<I', binary, 16)[0]):
        cmd, size = struct.unpack_from('<II', binary, pos)
        if cmd == 0x19:
            name = binary[pos+8:pos+24].split(b'\0')[0]
            va, vs, fo, fs = struct.unpack_from('<QQQQ', binary, pos+24)
            if name != b'__PAGEZERO' and vs:
                uc.mem_map(va, (vs+4095)&~4095)
                if fs: uc.mem_write(va, binary[fo:fo+fs])
        pos += size
    uc.mem_map(STACK, 0x10000)
    uc.mem_map(SOURCE, 0x100000)
    uc.mem_map(RETURN, 0x1000)
    return uc

def legacy_decode(uc, payload, key):
    sp = STACK + 0xff08
    uc.mem_write(sp, struct.pack('<Q', RETURN))
    uc.mem_write(SOURCE, payload)
    for reg, val in [(UC_X86_REG_RSP, sp), (UC_X86_REG_RDX, key),
                     (UC_X86_REG_RCX, SOURCE), (UC_X86_REG_R8, 0),
                     (UC_X86_REG_R9, len(payload))]:
        uc.reg_write(reg, val)
    uc.emu_start(0x1000c7536, RETURN, count=10000000)
    assert uc.reg_read(UC_X86_REG_RIP) == RETURN
    return bytes(uc.mem_read(SOURCE, len(payload)))

def checksum(uc, payload):
    sp=STACK+0xff08
    at=SOURCE+0x70000
    uc.mem_write(at,payload)
    uc.mem_write(sp,struct.pack('<Q',RETURN))
    for reg,value in [(UC_X86_REG_RSP,sp),(UC_X86_REG_RDX,at),
                      (UC_X86_REG_RCX,len(payload))]:
        uc.reg_write(reg,value)
    uc.emu_start(0x1000c76bd,RETURN,count=10000)
    assert uc.reg_read(UC_X86_REG_RIP)==RETURN
    assert bytes(uc.mem_read(at,len(payload)))==payload
    return uc.reg_read(UC_X86_REG_RAX)&255

def stage_block(uc, body, index, db_type):
    bp = STACK + 0x9000
    uc.reg_write(UC_X86_REG_RBP, bp)
    uc.reg_write(UC_X86_REG_RSP, bp-0x900)
    uc.mem_write(bp-0x858, struct.pack('<i', 0))
    uc.mem_write(bp-0x854, struct.pack('<i', index))
    uc.mem_write(bp-0x898, struct.pack('<Q', SOURCE))
    uc.mem_write(bp-0x8a0, struct.pack('<Q', db_type))
    uc.mem_write(bp-0x430, b'\xaa'*128)
    reached = []
    def hook(uc, address, size, _):
        if address in (0x1000f6755, 0x1000f678f):
            reached.append(address)
            uc.emu_stop()
    h = uc.hook_add(UC_HOOK_CODE, hook)
    try: uc.emu_start(0x1000f66d0, RETURN, count=1000)
    finally: uc.hook_del(h)
    assert len(reached) == 1
    block = bytes(uc.mem_read(bp-0x430,128))
    assert block == body[index*128:(index+1)*128]
    return reached[0]

def negotiate(uc, model, response, slot_types, lengths, offsets):
    """Run the real selection routine with only Objective-C services modeled."""
    sp = STACK + 0xff08
    out = SOURCE + 0x60000
    response_at = SOURCE + 0x50000
    uc.mem_write(response_at, response)
    uc.mem_write(out, b'\xff'*24)
    uc.mem_write(sp, struct.pack('<5Q', RETURN, 128, out, out+4, out+8))
    for reg, value in [(UC_X86_REG_RSP,sp),(UC_X86_REG_RDI,0x111),
                       (UC_X86_REG_RSI,0),(UC_X86_REG_RDX,0x222),
                       (UC_X86_REG_RCX,0x333),(UC_X86_REG_R8,0),
                       (UC_X86_REG_R9,response_at)]:
        uc.reg_write(reg,value)
    pointers = [(0x10011c098,RETURN+0x100),(0x10011c0a8,RETURN+0x110),
                (0x10011c0a0,RETURN+0x120)]
    old = [(a,bytes(uc.mem_read(a,8))) for a,_ in pointers]
    for a,dest in pointers:
        uc.mem_write(a,struct.pack('<Q',dest)); uc.mem_write(dest,b'\xc3')
    props = {'modelName':model, 'totalDownloadCnt':sum(lengths)}
    for i in (1,2):
        props[f'gpsDB{i}Type']=slot_types[i-1]
        props[f'gpsDB{i}FileLength']=lengths[i-1]
        props[f'gpsDB{i}FileOffset']=offsets[i-1]
    calls=[]
    def hook(uc,address,size,_):
        if address==RETURN+0x110:
            uc.reg_write(UC_X86_REG_RAX,uc.reg_read(UC_X86_REG_RDI))
        elif address==RETURN+0x120:
            uc.reg_write(UC_X86_REG_RAX,0)
        elif address==RETURN+0x100:
            at=uc.reg_read(UC_X86_REG_RSI)
            sel=bytes(uc.mem_read(at,100)).split(b'\0')[0].decode()
            calls.append(sel)
            if sel=='compareBytes:::':
                x=uc.reg_read(UC_X86_REG_RDX); y=uc.reg_read(UC_X86_REG_RCX)
                n=uc.reg_read(UC_X86_REG_R8)
                result=int(uc.mem_read(x,n)==uc.mem_read(y,n))
            elif sel=='setTotalDownloadCnt:':
                props['totalDownloadCnt']=uc.reg_read(UC_X86_REG_RDX);result=0
            else: result=props[sel]  # fail closed on unexpected methods
            uc.reg_write(UC_X86_REG_RAX,result)
    h=uc.hook_add(UC_HOOK_CODE,hook)
    try:
        uc.emu_start(0x1000f289d,RETURN,count=10000)
        assert uc.reg_read(UC_X86_REG_RIP)==RETURN
        result={'status':uc.reg_read(UC_X86_REG_RAX),
                'offset':struct.unpack('<i',uc.mem_read(out,4))[0],
                'blocks':struct.unpack('<i',uc.mem_read(out+4,4))[0],
                'type':struct.unpack('<Q',uc.mem_read(out+8,8))[0]}
    finally:
        uc.hook_del(h)
        for address,data in old:uc.mem_write(address,data)
    return result

def main():
    if not __debug__:
        raise SystemExit('Run without -O: these instruction checks require assertions')
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('updater',type=Path)
    ap.add_argument('database',type=Path)
    ap.add_argument('--output',type=Path,required=True)
    a=ap.parse_args()
    if a.output.resolve() in (a.updater.resolve(),a.database.resolve()):
        raise SystemExit('Output must not replace an input artifact')
    binary=a.updater.read_bytes(); db=a.database.read_bytes()
    digest=hashlib.sha256(binary).hexdigest()
    if digest != EXPECTED_SHA256: raise SystemExit('Unsupported updater hash; refuse address assumptions')
    if (db[-4:] != b'AEUS' or len(db)<=12 or len(db)>0x50000
            or (len(db)-12)%128):
        raise SystemExit('Expected a nonempty padded AEUS fixture of at most 320 KiB')
    uc=make_vm(binary)
    # Exercise varied byte/lane patterns against the independently
    # authored mathematical transpose, across several subtraction constants.
    import random
    rng=random.Random(8)
    payload=bytes(rng.randrange(256) for _ in range(4096))
    def reference(data,key):
        out=bytearray()
        for pos in range(0,len(data),4):
            w=data[pos:pos+4]
            for lane in range(4):
                value=sum(((w[j]>>(lane*2))&3)<<(j*2) for j in range(4))
                out.append((value-key)&255)
        return bytes(out)
    for key in (0,1,0xd2,0xe2,255):
        assert legacy_decode(uc,payload,key)==reference(payload,key)
    body=db[:-12]
    uc.mem_write(SOURCE,body)
    blocks=len(body)//128
    for i in range(blocks):
        assert stage_block(uc,body,i,1)==0x1000f678f
        block=body[i*128:(i+1)*128]
        expected_checksum=0
        for b in block:expected_checksum^=b
        assert checksum(uc,block)==expected_checksum
    assert stage_block(uc,body,0,0)==0x1000f6755
    negotiations=[]
    for model in (0x12,0x13,0x14,0x15,0x1c):
        r=negotiate(uc,model,b'RDY',(1,255),(len(db),0),(0,0))
        assert r=={'status':8,'offset':0,'blocks':blocks,'type':1}
        negotiations.append({'model_id':model,'case':'AEUS slot 1, RDY','result':r})
        r=negotiate(uc,model,b'RDY',(0,255),(len(db),0),(0,0))
        assert r['status']==2
        negotiations.append({'model_id':model,'case':'legacy only, RDY','result':r})
    r=negotiate(uc,0x12,b'RDA',(1,255),(len(db),0),(0,0))
    assert r['status']==1
    negotiations.append({'model_id':0x12,'case':'AEUS slot 1, wrong RDA response','result':r})
    r=negotiate(uc,0x12,b'RDY',(0,1),(128,len(db)),(0,512))
    assert r=={'status':8,'offset':512,'blocks':blocks,'type':1}
    negotiations.append({'model_id':0x12,'case':'AEUS slot 2, RDY','result':r})
    r=negotiate(uc,7,b'RDY',(0,255),(len(db),0),(0,0))
    assert r=={'status':8,'offset':0,'blocks':blocks,'type':0}
    negotiations.append({'model_id':7,'case':'R7 legacy control, RDY','result':r})
    report={
      'updater_sha256':digest,'database_sha256':hashlib.sha256(db).hexdigest(),
      'method':'Unicorn execution of retained x86-64 instructions; isolated function/window',
      'legacy_decoder':{'entry':'0x1000c7536',
                        'synthetic_reference_cases':5,'bytes_per_reference_case':4096,
                        'operation':'transpose two-bit lanes, then subtract byte key modulo 256'},
      'upload_copy':{'entry':'0x1000f66d0','database_type':1,
                     'block_size':128,'unchanged_blocks':blocks,
                     'unchanged_bytes':len(body),'reaches_checksum_without_legacy_decoder':True,
                     'type_zero_enters_legacy_decoder':True},
      'checksum':{'entry':'0x1000c76bd','algorithm':'bytewise XOR',
                  'passed_blocks':blocks,'payload_unchanged':True},
      'type_negotiation':{'entry':'0x1000f289d','passed_cases':len(negotiations),
                          'cases':negotiations,'objc_runtime':'modeled property access and byte comparison'},
      'limitations':['Objective-C runtime and property getters are modeled; selection instructions are executed.',
                     'Serial I/O, surrounding application and device behavior are outside this emulation.',
                     'No AEUS key or general encoder recovered; no physical alert verified.']}
    a.output.write_text(json.dumps(report,indent=2)+'\n')
    print(f'PASS: 5 synthetic decoder cases; {blocks} AEUS blocks copied unchanged with XOR verified; {len(negotiations)} negotiation cases')

if __name__=='__main__':main()
