// Import a caller-extracted DA14585 BLES image at 0x07fc0000, then seed Thumb vectors.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.lang.Register;
import java.math.BigInteger;

public class SeedR8Ble extends GhidraScript {
    public void run() throws Exception {
        long base = 0x07fc0000L;
        if (currentProgram.getMinAddress().getOffset() != base) {
            throw new IllegalArgumentException("Import BLES with BinaryLoader base 0x07fc0000");
        }
        Register thumb = currentProgram.getRegister("TMode");
        if (thumb == null) throw new IllegalArgumentException("An ARM Thumb language is required");
        currentProgram.getProgramContext().setValue(thumb,
            currentProgram.getMinAddress(), currentProgram.getMaxAddress(), BigInteger.ONE);
        for (int i = 1; i < 16; i++) {
            long vector = Integer.toUnsignedLong(getInt(toAddr(base + 4L*i)));
            if (vector == 0) continue;
            long target = vector & ~1L;
            Address entry = toAddr(target);
            if ((vector & 1) == 0 || !currentProgram.getMemory().contains(entry)) {
                throw new IllegalArgumentException("Invalid core vector index " + i);
            }
            disassemble(entry);
            if (getFunctionAt(entry) == null) createFunction(entry, i == 1 ? "ble_reset" : "ble_vector_"+i);
        }
    }
}
