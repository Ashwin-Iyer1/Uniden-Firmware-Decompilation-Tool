// Seed a decoded R7 MCU image before Ghidra's normal auto-analysis.
// @category R7
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.ArrayDataType;
import ghidra.program.model.data.DWordDataType;
import ghidra.program.model.data.PointerDataType;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Function;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.SourceType;
import java.io.ByteArrayInputStream;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

public class R7Seed extends GhidraScript {
    private final StringBuilder report = new StringBuilder();

    private void note(String message) {
        println(message);
        report.append(message).append('\n');
    }

    private void seed(long value, String name) throws Exception {
        Address address = toAddr(value & ~1L);
        MemoryBlock block = currentProgram.getMemory().getBlock(address);
        if (block == null || !block.isExecute() || !block.isInitialized()) {
            note("SKIP outside executable flash: " + name + " @ " + address);
            return;
        }
        Function containing = getFunctionContaining(address);
        if (containing != null) {
            note("EXISTING " + name + " @ " + address + " in " + containing.getName());
            return;
        }
        // Do not clear defined data or split an existing function to satisfy a seed.
        if (getDataContaining(address) != null) {
            note("SKIP defined data: " + name + " @ " + address);
            return;
        }
        if (currentProgram.getListing().getInstructionContaining(address) != null && getInstructionAt(address) == null) {
            note("SKIP inside existing instruction: " + name + " @ " + address);
            return;
        }
        if (getInstructionAt(address) == null && !disassemble(address)) {
            note("FAILED disassembly: " + name + " @ " + address);
            return;
        }
        Function function = createFunction(address, name);
        note((function == null ? "FAILED function: " : "SEEDED ") + name + " @ " + address);
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 5) {
            throw new IllegalArgumentException("R7Seed.java <ui_nu|dsp_nu|gps_nu> <data.bin|-> <output-dir> <sram-size> <bss-size>");
        }
        String section = args[0];
        int vectors = section.equals("gps_nu") ? 80 : 158;
        if (!section.equals("ui_nu") && !section.equals("dsp_nu") && !section.equals("gps_nu")) {
            throw new IllegalArgumentException("Unsupported section " + section);
        }
        Path output = Path.of(args[2]);
        Files.createDirectories(output);
        Memory memory = currentProgram.getMemory();
        Register thumb = currentProgram.getRegister("TMode");
        if (thumb == null) throw new IllegalStateException("Language has no TMode register");
        // Raw binary imports have one flash block. The Thumb context is a decoding
        // context, not an instruction claim: data is not disassembled en masse.
        for (MemoryBlock block : memory.getBlocks()) {
            if (block.getStart().getOffset() < 0x20000000L) {
                block.setRead(true);
                block.setWrite(false);
                block.setExecute(true);
                currentProgram.getProgramContext().setValue(thumb, block.getStart(), block.getEnd(), BigInteger.ONE);
            }
        }
        int sramSize = Integer.decode(args[3]);
        int bssSize = Integer.decode(args[4]);
        byte[] initialized = args[1].equals("-") ? new byte[0] : Files.readAllBytes(Path.of(args[1]));
        if (initialized.length + bssSize > sramSize) throw new IllegalArgumentException(".data/.bss exceeds SRAM model");
        if (memory.getBlock(toAddr(0x20000000L)) == null) {
            if (initialized.length != 0) {
                MemoryBlock data = memory.createInitializedBlock("SRAM_data_boot", toAddr(0x20000000L),
                    new ByteArrayInputStream(initialized), initialized.length, monitor, false);
                data.setRead(true); data.setWrite(true); data.setExecute(false);
                data.setComment("Initial runtime .data reconstructed from the firmware copy descriptor; mutable after boot.");
            }
            if (bssSize != 0) {
                MemoryBlock bss = memory.createInitializedBlock("SRAM_bss_boot", toAddr(0x20000000L + initialized.length),
                    new ByteArrayInputStream(new byte[bssSize]), bssSize, monitor, false);
                bss.setRead(true); bss.setWrite(true); bss.setExecute(false);
                bss.setComment("Boot-zeroed .bss from the startup copy descriptor; mutable after boot.");
            }
            if (initialized.length + bssSize < sramSize) {
                MemoryBlock ram = memory.createUninitializedBlock("SRAM_runtime", toAddr(0x20000000L + initialized.length + bssSize),
                    sramSize - initialized.length - bssSize, false);
                ram.setRead(true); ram.setWrite(true); ram.setExecute(false);
                ram.setComment("Analysis address-space model only; not a hardware SRAM-size measurement. Runtime values unknown.");
            }
        }
        note("SRAM model bytes=" + sramSize + "; initialized boot .data bytes=" + initialized.length + "; boot .bss bytes=" + bssSize);
        createData(toAddr(0), new ArrayDataType(DWordDataType.dataType, vectors, 4));
        createLabel(toAddr(0), "r7_vector_table", true, SourceType.ANALYSIS);
        // Only actual exception-vector slots are interpreted as pointers here.
        Map<Long, String> starts = new LinkedHashMap<>();
        for (int i = 1; i < vectors; i++) {
            long pointer = Integer.toUnsignedLong(memory.getInt(toAddr(i * 4L)));
            if ((pointer & 1) == 0 || pointer == 0xffffffffL) continue;
            String name = i == 1 ? "Reset_Handler" : i < 16 ? "Exception_" + i : "IRQ_" + (i - 16);
            starts.putIfAbsent(pointer & ~1L, name);
        }
        // Documented function starts only. Interior switch cases, literal pools,
        // arbitrary odd flash words and guessed prologues are deliberately absent.
        long[] documented;
        if (section.equals("ui_nu")) {
            documented = new long[] {0x278,0x290,0x3d4,0x488,0xc70,0x14a0,0x58dc,0x6efc,
                0x77e0,0x8a0c,0x91ac,0x9268,0xb340,0xd31c,0xd330,0xd468,0xd61c,0xd994,
                0xe214,0xe4bc,0xf1a0,0xf5f4,0x100e0,0x11114,0x1117c,0x13e3c,0x16eb4,
                0x17b54,0x1b600,0x1b890,0x1d29c,0x1e23c};
            // These two tables are identified by their dispatch consumers in
            // FIRMWARE_MAP §1.4, not by scanning arbitrary .data for odd words.
            long[] tables = {0x200000dcL, 0x20000118L};
            int[] counts = {9, 5};
            for (int table = 0; table < tables.length; table++) {
                for (int index = 0; index < counts[table]; index++) {
                    long slot = tables[table] + 4L * index;
                    long pointer = Integer.toUnsignedLong(memory.getInt(toAddr(slot)));
                    if ((pointer & 1) == 0 || pointer < 0x278 || pointer >= 0x1fbca) {
                        throw new IllegalStateException("Invalid UI dispatch pointer @ " + Long.toHexString(slot));
                    }
                    createData(toAddr(slot), PointerDataType.dataType);
                    starts.putIfAbsent(pointer & ~1L, String.format("ui_dispatch_%s_%02d", table == 0 ? "A" : "B", index));
                    note(String.format("TABLE UI_%s[%d] @ %08x -> %08x", table == 0 ? "A" : "B", index, slot, pointer));
                }
            }
        } else if (section.equals("dsp_nu")) {
            documented = new long[] {0x2e6a,0x2ea0,0x47e0,0x4b58,0x516c,0x53a0,0x53c0,
                0x5788,0x5c74,0x8908,0x9f14,0xbb88,0xc41c,0xc644,0xc780,0xcea4,0xced8,0xd68c,0xdb76};
            // Parser 0x2f78 proves 30 records of {index,name_ptr,handler_ptr}
            // with stride 12 at 0xdbcc. Require every index/name/code bound.
            for (int index = 0; index < 30; index++) {
                long slot = 0xdbccL + index * 12L;
                long storedIndex = Integer.toUnsignedLong(memory.getInt(toAddr(slot)));
                long namePointer = Integer.toUnsignedLong(memory.getInt(toAddr(slot + 4)));
                long pointer = Integer.toUnsignedLong(memory.getInt(toAddr(slot + 8)));
                if (storedIndex != index || namePointer < 0x1beb8 || namePointer > 0x1bf40 ||
                    (pointer & 1) == 0 || pointer < 0x278 || pointer >= 0xdbcc) {
                    throw new IllegalStateException("Invalid DSP console table record " + index);
                }
                StringBuilder command = new StringBuilder();
                boolean terminated = false;
                for (int c = 0; c < 16; c++) {
                    int value = memory.getByte(toAddr(namePointer + c)) & 255;
                    if (value == 0) { terminated = true; break; }
                    if (value < 32 || value > 126) throw new IllegalStateException("Non-ASCII console name");
                    command.append((char)value);
                }
                if (!terminated) throw new IllegalStateException("Unterminated console name");
                createData(toAddr(slot), DWordDataType.dataType);
                createData(toAddr(slot + 4), PointerDataType.dataType);
                createData(toAddr(slot + 8), PointerDataType.dataType);
                starts.putIfAbsent(pointer & ~1L, String.format("dsp_console_%02d_%s", index,
                    command.length() == 0 ? "default" : command.toString().replaceAll("[^A-Za-z0-9]", "_")));
                note(String.format("TABLE DSP console[%d] %s @ %08x -> %08x", index, command, slot, pointer));
            }
        } else {
            documented = new long[] {0x153c,0x2684,0x2894,0x2c88,0x3c0c,0x5dd0,0x6410,0x86c4,0x92b4,0x9c1c};
        }
        for (long address : documented) starts.putIfAbsent(address, String.format("FUN_%08x", address));
        for (Map.Entry<Long, String> entry : starts.entrySet()) {
            monitor.checkCancelled();
            try { seed(entry.getKey(), entry.getValue()); }
            catch (Exception exception) { note("ERROR " + entry.getValue() + ": " + exception); }
        }
        Files.writeString(output.resolve("seed_report.txt"), report.toString());
    }
}
