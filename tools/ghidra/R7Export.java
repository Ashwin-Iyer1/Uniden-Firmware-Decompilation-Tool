// Export every function discovered by the current Ghidra analysis.
// @category R7
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.mem.MemoryBlock;
import java.io.BufferedWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

public class R7Export extends GhidraScript {
    private static final String LIMIT = "Ghidra-generated C-like pseudocode, not original source and not guaranteed compilable. " +
        "Exports cover discovered functions only; indirect or unreachable functions may remain undiscovered. " +
        "Unclassified bytes include possible code, data and padding; byte coverage is not a completeness proof.";

    private static String json(String value) {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            if (c == '"' || c == '\\') result.append('\\').append(c);
            else if (c == '\n') result.append("\\n");
            else if (c == '\r') result.append("\\r");
            else if (c == '\t') result.append("\\t");
            else if (c < 32) result.append(String.format("\\u%04x", (int)c));
            else result.append(c);
        }
        return result.append('"').toString();
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format("%02x", b & 255));
        return result.toString();
    }

    private String digest(MemoryBlock block, MessageDigest flashDigest) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long offset = 0;
        byte[] buffer = new byte[65536];
        while (offset < block.getSize()) {
            int count = (int)Math.min(buffer.length, block.getSize() - offset);
            int read = currentProgram.getMemory().getBytes(block.getStart().add(offset), buffer, 0, count);
            if (read != count) throw new IllegalStateException("Short memory read in " + block.getName());
            digest.update(buffer, 0, count);
            if (flashDigest != null) flashDigest.update(buffer, 0, count);
            offset += count;
        }
        return hex(digest.digest());
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 2) throw new IllegalArgumentException("R7Export.java <output-dir> <seconds-per-function>");
        Path output = Path.of(args[0]);
        int timeout = Integer.parseInt(args[1]);
        if (timeout < 1) throw new IllegalArgumentException("Timeout must be positive");
        Files.createDirectories(output.resolve("functions"));
        List<Function> functions = new ArrayList<>();
        FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
        while (iterator.hasNext()) functions.add(iterator.next());
        AddressSet flash = new AddressSet();
        MessageDigest flashDigest = MessageDigest.getInstance("SHA-256");
        StringBuilder blocks = new StringBuilder("[");
        for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
            boolean executableFlash = block.isInitialized() && block.isExecute();
            if (block.isInitialized() && block.isExecute()) flash.add(block.getStart(), block.getEnd());
            String hash = block.isInitialized() ? digest(block, executableFlash ? flashDigest : null) : null;
            if (blocks.length() > 1) blocks.append(',');
            blocks.append("{\"name\":").append(json(block.getName())).append(",\"start\":").append(json(block.getStart().toString()))
                .append(",\"end\":").append(json(block.getEnd().toString())).append(",\"bytes\":").append(block.getSize())
                .append(",\"initialized\":").append(block.isInitialized()).append(",\"read\":").append(block.isRead())
                .append(",\"write\":").append(block.isWrite()).append(",\"execute\":").append(block.isExecute())
                .append(",\"sha256\":").append(json(hash)).append('}');
        }
        blocks.append(']');
        String actualFlashHash = hex(flashDigest.digest());
        AddressSet instructionBytes = new AddressSet();
        InstructionIterator instructions = currentProgram.getListing().getInstructions(flash, true);
        long instructionCount = 0;
        while (instructions.hasNext()) {
            Instruction instruction = instructions.next();
            instructionBytes.add(instruction.getMinAddress(), instruction.getMaxAddress());
            instructionCount++;
        }
        AddressSet dataBytes = new AddressSet();
        DataIterator dataIterator = currentProgram.getListing().getDefinedData(flash, true);
        while (dataIterator.hasNext()) {
            Data data = dataIterator.next();
            dataBytes.add(data.getMinAddress(), data.getMaxAddress());
        }
        AddressSet unclassified = flash.subtract(instructionBytes).subtract(dataBytes);
        try (BufferedWriter ranges = Files.newBufferedWriter(output.resolve("unclassified_flash_ranges.csv"))) {
            ranges.write("start,end,bytes\n");
            for (AddressRange range : unclassified.getAddressRanges()) {
                ranges.write(range.getMinAddress() + "," + range.getMaxAddress() + "," + range.getLength() + "\n");
            }
        }
        DecompInterface decompiler = new DecompInterface();
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(false);
        if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException(decompiler.getLastMessage());
        int success = 0, timedOut = 0, failure = 0, errors = 0;
        AddressSet bodies = new AddressSet();
        String summary;
        try (BufferedWriter manifest = Files.newBufferedWriter(output.resolve("functions.json"));
             BufferedWriter combined = Files.newBufferedWriter(output.resolve("all_functions.c"));
             BufferedWriter assembly = Files.newBufferedWriter(output.resolve("all_functions.asm"))) {
            combined.write("/* " + LIMIT + " */\n\n");
            assembly.write("; Function-scoped disassembly. " + LIMIT + "\n\n");
            manifest.write("{\n  \"schema_version\": 1,\n  \"program\": " + json(currentProgram.getName()) +
                ",\n  \"ghidra_version\": " + json(Application.getApplicationVersion()) +
                ",\n  \"language\": " + json(currentProgram.getLanguageID().toString()) +
                ",\n  \"image_base\": " + json(currentProgram.getImageBase().toString()) +
                ",\n  \"flash_sha256\": " + json(actualFlashHash) +
                ",\n  \"memory_blocks\": " + blocks +
                ",\n  \"limitation\": " + json(LIMIT) + ",\n  \"timeout_seconds_per_function\": " + timeout + ",\n  \"functions\": [\n");
            int index = 0;
            for (Function function : functions) {
                monitor.checkCancelled();
                bodies.add(function.getBody());
                String name = function.getName();
                String address = function.getEntryPoint().toString();
                String basename = String.format("%08x", function.getEntryPoint().getOffset()) + "_" +
                    name.replaceAll("[^A-Za-z0-9_.-]", "_");
                if (basename.length() > 120) basename = basename.substring(0, 120);
                String status = "failure", error = "", c = "", asmError = "";
                long started = System.nanoTime();
                try {
                    DecompileResults result = decompiler.decompileFunction(function, timeout, monitor);
                    if (result != null && result.decompileCompleted() && result.getDecompiledFunction() != null) {
                        c = result.getDecompiledFunction().getC(); status = "success"; success++;
                        error = result.getErrorMessage();
                    } else if (result != null && result.isTimedOut()) {
                        status = "timeout"; timedOut++; error = result.getErrorMessage();
                    } else {
                        failure++; error = result == null ? "Decompiler returned null" : result.getErrorMessage();
                    }
                } catch (Exception exception) { status = "error"; errors++; error = exception.toString(); }
                long elapsedMillis = (System.nanoTime() - started) / 1000000;
                String banner = "/* " + name.replace("*/", "* /") + " @ " + address + "; status=" + status + " */\n";
                if (!status.equals("success")) c = "/* " + String.valueOf(error).replace("*/", "* /") + " */\n";
                Files.writeString(output.resolve("functions").resolve(basename + ".c"), "/* " + LIMIT + " */\n" + banner + c);
                combined.write(banner + c + "\n\n");
                StringBuilder asm = new StringBuilder("; " + name + " @ " + address + "\n");
                try {
                    InstructionIterator body = currentProgram.getListing().getInstructions(function.getBody(), true);
                    while (body.hasNext()) {
                        Instruction instruction = body.next();
                        asm.append(instruction.getAddress()).append("  ").append(hex(instruction.getBytes()))
                            .append("  ").append(instruction.toString()).append('\n');
                    }
                } catch (Exception exception) { asmError = exception.toString(); }
                Files.writeString(output.resolve("functions").resolve(basename + ".asm"), asm.toString());
                assembly.write(asm.toString() + "\n");
                if (index != 0) manifest.write(",\n");
                manifest.write("    {\"address\":" + json(address) + ",\"name\":" + json(name) +
                    ",\"body_bytes\":" + function.getBody().getNumAddresses() + ",\"status\":" + json(status) +
                    ",\"error\":" + json(error) + ",\"elapsed_ms\":" + elapsedMillis +
                    ",\"c_file\":" + json("functions/" + basename + ".c") +
                    ",\"assembly_file\":" + json("functions/" + basename + ".asm") +
                    ",\"assembly_error\":" + json(asmError) + "}");
                index++;
                if (index % 50 == 0 || index == functions.size()) {
                    manifest.flush(); combined.flush(); assembly.flush();
                    println("Exported " + index + "/" + functions.size() + " functions; success=" + success + ", timeout=" + timedOut);
                }
            }
            summary = "{\"discovered_functions\":" + functions.size() + ",\"decompiled_successfully\":" + success +
                ",\"timeouts\":" + timedOut + ",\"failures\":" + failure + ",\"errors\":" + errors +
                ",\"loaded_flash_bytes\":" + flash.getNumAddresses() + ",\"defined_instructions\":" + instructionCount +
                ",\"defined_instruction_bytes\":" + instructionBytes.getNumAddresses() +
                ",\"defined_data_bytes\":" + dataBytes.getNumAddresses() +
                ",\"function_body_bytes_in_flash\":" + bodies.intersect(flash).getNumAddresses() +
                ",\"unclassified_flash_bytes\":" + unclassified.getNumAddresses() + "}";
            manifest.write("\n  ],\n  \"summary\": " + summary + "\n}\n");
        } finally { decompiler.dispose(); }
        Files.writeString(output.resolve("README.txt"), LIMIT + "\n\nfunctions.json records every discovered function and its export status.\n" +
            "summary.json exists only after all function writers closed successfully.\n" +
            "Memory-block hashes/permissions describe the saved Ghidra program at export time.\n" +
            "unclassified_flash_ranges.csv is a follow-up inventory, not a list of missing functions.\n");
        // Completion marker is last, after every manifest/combined writer closed.
        Files.writeString(output.resolve("summary.json"), summary + "\n");
        println("R7 export complete: " + summary);
    }
}
