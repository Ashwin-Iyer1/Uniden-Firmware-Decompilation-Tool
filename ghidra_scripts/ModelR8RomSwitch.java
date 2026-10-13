// Optional analysis model, NOT a dump of the ROM routine. No firmware bytes change.
// The caller supplies the ROM address. Validate inline table bounds and retain
// this assumption when interpreting decompiler output.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.data.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.util.*;

public class ModelR8RomSwitch extends GhidraScript {
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Supply the ROM helper address");
        Address rom = toAddr(Long.decode(args[0]));
        if (currentProgram.getMemory().contains(rom)) {
            throw new IllegalArgumentException("This model is only for an unmapped ROM helper");
        }
        ghidra.framework.options.Options modelOptions = currentProgram.getOptions("R8 BLE ROM model");
        modelOptions.setBoolean("completed", false);
        modelOptions.setString("assumed_rom_helper", rom.toString());
        modelOptions.setString("assumed_abi", "switch8_r3");
        modelOptions.setBoolean("assumed_constant_inline_tables", true);
        Function helper = getFunctionAt(rom);
        if (helper == null) {
            helper = currentProgram.getFunctionManager().createFunction(
                "__ARM_common_switch8", rom, new AddressSet(rom), SourceType.USER_DEFINED);
        }
        helper.setCallFixup("switch8_r3");
        helper.setComment("Assumed ARM switch8_r3 ABI; ROM bytes absent. Based on r3-indexed inline tables. No runtime verification.");
        List<Instruction> calls = new ArrayList<>();
        for (Instruction instruction : currentProgram.getListing().getInstructions(true)) {
            if (!instruction.getFlowType().isCall()) continue;
            for (Address target : instruction.getFlows()) {
                if (target.equals(rom)) { calls.add(instruction); break; }
            }
        }
        Set<Function> owners = new LinkedHashSet<>();
        Map<Address,List<Address>> tables = new LinkedHashMap<>();
        int modeled = 0;
        for (Instruction call : calls) {
            Address table = call.getAddress().add(call.getLength());
            if (!currentProgram.getMemory().contains(table)) continue;
            int count = Byte.toUnsignedInt(getByte(table));
            if (count < 1 || count > 64) continue;
            Address end = table.add(count+1);
            if (!currentProgram.getMemory().contains(end)) continue;
            List<Address> targets = new ArrayList<>();
            boolean valid = true;
            for (int i = 0; i <= count; i++) {
                int displacement = Byte.toUnsignedInt(getByte(table.add(1+i))) * 2;
                Address target = table.add(displacement);
                if (target.compareTo(end) <= 0 || (target.getOffset() & 1) != 0 ||
                    !currentProgram.getMemory().contains(target)) { valid = false; break; }
                targets.add(target);
            }
            if (!valid) continue;
            Function owner = getFunctionContaining(call.getAddress());
            if (owner != null) owners.add(owner);
            clearListing(table, end);
            Data tableData = createData(table, new ArrayDataType(ByteDataType.dataType, count+2, 1));
            MutabilitySettingsDefinition.DEF.setChoice(tableData, MutabilitySettingsDefinition.CONSTANT);
            // Cortex RAM images import as writable. Model ONLY the inline
            // compiler table as immutable so the decompiler can bound its
            // indirect branch; retain this static-analysis assumption.
            ghidra.program.model.mem.MemoryBlock block = currentProgram.getMemory().getBlock(table);
            if (!block.getStart().equals(table)) currentProgram.getMemory().split(block, table);
            block = currentProgram.getMemory().getBlock(table);
            if (block.getEnd().compareTo(end) > 0) currentProgram.getMemory().split(block, end.add(1));
            currentProgram.getMemory().getBlock(table).setWrite(false);
            tableData.setComment(CodeUnit.EOL_COMMENT, "Analysis model: constant inline switch8_r3 table; ROM implementation absent.");
            call.setFlowOverride(FlowOverride.NONE);
            for (Address target : new LinkedHashSet<>(targets)) {
                disassemble(target);
                currentProgram.getReferenceManager().addMemoryReference(call.getAddress(),
                    target, RefType.COMPUTED_JUMP, SourceType.USER_DEFINED, 0);
            }
            tables.put(call.getAddress(), targets);
            println("ROM switch model: call=" + call.getAddress() + " table=" + table +
                " count=" + count + " targets=" + targets);
            modeled++;
        }
        for (Function owner : owners) {
            // Normal function-body discovery sees an external CALL followed by
            // data. Follow the explicitly modeled case edges instead. Keep
            // calls out of the body, and do not absorb other function entries.
            AddressSet body = new AddressSet();
            Set<Address> visited = new HashSet<>();
            Deque<Address> pending = new ArrayDeque<>();
            pending.add(owner.getEntryPoint());
            while (!pending.isEmpty()) {
                Address address = pending.removeFirst();
                if (!visited.add(address)) continue;
                if (visited.size() > 4096) throw new IllegalArgumentException("Function-body model exceeded bound");
                Instruction instruction = getInstructionAt(address);
                if (instruction == null) continue;
                Function other = getFunctionContaining(address);
                if (other != null && !other.equals(owner)) continue;
                body.add(instruction.getMinAddress(), instruction.getMaxAddress());
                List<Address> cases = tables.get(address);
                if (cases != null) { pending.addAll(cases); continue; }
                Address fallthrough = instruction.getFallThrough();
                if (fallthrough != null) pending.add(fallthrough);
                if (instruction.getFlowType().isJump()) {
                    for (Address target : instruction.getFlows()) {
                        if (currentProgram.getMemory().contains(target)) pending.add(target);
                    }
                }
            }
            owner.setBody(body);
        }
        modelOptions.setInt("modeled_inline_tables", modeled);
        modelOptions.setBoolean("completed", true);
        println("Modeled " + modeled + " bounded inline tables; ROM ABI remains an explicit assumption.");
    }
}
